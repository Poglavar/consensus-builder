// property-offer/v2: one plot or one flat, SOL or USDC, the maker's lens set, and one identity per asset.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Offer = require('../../frontend/js/property-offer-record.js');

const MAKER = '11111111111111111111111111111111';
const LENS_A = 'SysvarRent111111111111111111111111111111111';
const LENS_B = 'SysvarC1ock11111111111111111111111111111111';
const plot = { kind: 'parcel', sourceId: 'kz-alatau-pkk', id: 'KZ-ALATAU-PKK-03341030011-g7211003', at: '43.8011,77.0901,18' };
const flat = { kind: 'flat', xrayBuilding: 'design::bafkreieyimgcelmg7a3tlylacmtjngd3zefgml3plwxgesgjaj6ijaoqry::0', unit: '4::2', at: '43.801075,77.090093,19' };
const base = {
    schema: 'property-offer/v2', city: 'alatau', createdAt: '2026-11-27T00:00:00.000Z', expiresAt: '2026-12-27T00:00:00.000Z',
    direction: 'buy', proposer: MAKER, currency: 'USDC', price: '250000000', lens: { members: [LENS_A, LENS_B], threshold: 2 }, asset: plot
};

describe('property-offer/v2', () => {
    it('gives a buy offer for one plot one CID and keeps its lens set', () => {
        const content = Offer.published(base);
        expect(Offer.validate(content)).toBeNull();
        expect(content.lens).toEqual({ members: [LENS_A, LENS_B], threshold: 2 });
        expect(Offer.cid(content)).toMatch(/^bafkrei[a-z2-7]{52}$/);
    });

    it('requires a buyer’s lens with a threshold inside it, and allows a seller without one', () => {
        for (const lens of [{ members: [], threshold: 0 }, { members: [LENS_A], threshold: 2 }, { members: [LENS_A, LENS_A], threshold: 1 }, { members: [LENS_A], threshold: 0 }]) {
            expect(Offer.validate({ ...base, lens })).not.toBeNull();
        }
        const sale = { ...base, direction: 'sell', lens: { members: [], threshold: 0 }, payouts: [{ recipient: MAKER, amount: '250000000' }] };
        expect(Offer.validate(sale)).toBeNull();
        expect(Offer.validate({ ...sale, payouts: [{ recipient: MAKER, amount: '1' }] })).not.toBeNull();
        expect(Offer.validate({ ...base, payouts: sale.payouts })).not.toBeNull();
    });

    it('identifies a plot by source and id, and a flat by building, storey and flat number, whatever the price or location', () => {
        expect(Offer.assetKey(plot)).toBe(JSON.stringify(['parcel/v1', plot.sourceId, plot.id]));
        expect(Offer.assetKey(flat)).toBe(JSON.stringify(['flat/v1', flat.xrayBuilding, 4, 2]));
        expect(Offer.assetHash({ ...flat, at: '0,0,19' })).toBe(Offer.assetHash(flat));
        expect(Offer.assetHash({ ...flat, unit: '4::3' })).not.toBe(Offer.assetHash(flat));
        expect(Offer.validate({ ...base, asset: flat })).toBeNull();
        expect(Offer.validate({ ...base, asset: { ...flat, unit: '4::flat-2-4::9b3e512081c9f2367f1ded75' } })).not.toBeNull();
        expect(Offer.validate({ ...base, asset: { ...flat, xrayBuilding: 'almaty::osm::w1' } })).not.toBeNull();
        expect(Offer.validate({ ...base, asset: { ...plot, parcels: [] } })).not.toBeNull();
    });

    it('reads typed prices with either decimal mark and formats them back', () => {
        expect(Offer.parseAmount('1,25', 'SOL')).toBe('1250000000');
        expect(Offer.parseAmount('250', 'USDC')).toBe('250000000');
        expect(Offer.parseAmount('0.0000001', 'USDC')).toBeNull();
        expect(Offer.parseAmount('0', 'SOL')).toBeNull();
        expect(Offer.formatAmount('1250000000', 'SOL')).toBe('1.25');
        expect(Offer.formatAmount('250000000', 'USDC')).toBe('250');
        expect(Offer.validate({ ...base, currency: 'EUR' })).not.toBeNull();
    });
});
