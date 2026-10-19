// The lump-offer migration (scripts/migrate-readjustment-lump-offers.mjs): a pre-ledger readjustment's
// offer is split over its owners by percent, exact to the cent, in EUR, and only then validates.
import { describe, expect, it } from 'vitest';
import { parseArgs, planRow, splitCents, validateMigrated } from '../scripts/migrate-readjustment-lump-offers.mjs';
import { serializeProposalRow } from '../proposals/serializer.js';
import { validateReadjustmentProposal } from '../routes/reparcellization.js';

const square = (x, y, d = 0.0005) => ({ type: 'Polygon', coordinates: [[[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]] });
const owners = n => Array.from({ length: n }, (_, i) => ({ ownerKey: `lot-${i + 1}`, displayName: 'Owner', percent: 1 / n }));

function legacyRow(n = 3, offer = '100000.00000000') {
    const polygons = Array.from({ length: n }, (_, i) => ({ ownerKey: `lot-${i + 1}`, percent: 100 / n, geometry: square(15.98 + i * 0.0005, 45.80) }));
    const reparcellization = { polygons, ownerShares: owners(n), algorithm: 'grid' };
    return {
        id: 7, proposal_id: 'p-legacy', city: 'zg', type: 'reparcellization', title: 'Legacy readjustment',
        offer, offer_currency: 'USDT', cadastre_parcel_ids: ['HR-1-1'], reparcellization,
        proposal_data: { goal: 'reparcellization', offer: Number(offer), offerCurrency: 'USDT', reparcellization }
    };
}

describe('splitCents', () => {
    it('sums exactly and spreads the remainder one cent at a time', () => {
        expect(splitCents(10000, [1 / 3, 1 / 3, 1 / 3])).toEqual([3334, 3333, 3333]);
        const split = splitCents(34223700, Array(9).fill(1 / 9));
        expect(split.reduce((a, b) => a + b, 0)).toBe(34223700);
        expect(Math.max(...split) - Math.min(...split)).toBeLessThanOrEqual(1);
    });
});

describe('planRow', () => {
    it('gives every owner a cashOffer that sums to the offer, in EUR, on both copies of the ledger', () => {
        const plan = planRow(legacyRow());
        expect(plan.class).toBe('migratable');
        expect(plan.offerCurrency).toBe('EUR');
        expect(plan.reparcellization.ownerShares.map(o => o.cashOffer)).toEqual([33333.34, 33333.33, 33333.33]);
        expect(plan.proposalData.reparcellization.ownerShares).toEqual(plan.reparcellization.ownerShares);
        expect(plan.proposalData.offerCurrency).toBe('EUR');
    });

    it('leaves rows that already have a ledger, no offer, ownerless ground or odd percents alone', () => {
        const withLedger = legacyRow();
        withLedger.reparcellization.ownerShares[0].cashOffer = 5;
        expect(planRow(withLedger).reason).toBe('has-ledger');
        expect(planRow(legacyRow(3, '0')).reason).toBe('no-offer');
        const open = legacyRow();
        open.reparcellization.ownerShares[1].ownerKey = 'open-ground';
        expect(planRow(open).reason).toBe('ownerless-ground');
        const odd = legacyRow();
        odd.reparcellization.ownerShares[0].percent = 0.9;
        expect(planRow(odd).reason).toBe('percents-not-1');
    });

    it('is idempotent: a migrated row no longer qualifies', () => {
        const row = legacyRow();
        const plan = planRow(row);
        expect(planRow({ ...row, reparcellization: plan.reparcellization }).reason).toBe('has-ledger');
    });
});

describe('validateMigrated', () => {
    it('the legacy row fails the deal validator on the ledger and the migrated one does not', () => {
        const row = legacyRow();
        const before = validateReadjustmentProposal(serializeProposalRow(row));
        expect(before.errors.map(e => e.message).join(' ')).toMatch(/owner cash ledger/);
        const after = validateMigrated(row, planRow(row)) || '';
        expect(after).not.toMatch(/owner cash ledger|use EUR/);
    });
});

describe('parseArgs', () => {
    it('defaults to a dry run and refuses apply with restore', () => {
        expect(parseArgs([])).toMatchObject({ apply: false, restore: false, ids: null });
        expect(parseArgs(['--ids', '18,19']).ids).toEqual([18, 19]);
        expect(() => parseArgs(['--apply', '--restore'])).toThrow();
    });
});
