// What an abstract owner sees before accepting: contributed land, a readjustment's plots and cash,
// the conditions, and the tally before and after their own acceptance.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';

const require = createRequire(import.meta.url);
const review = require('../../frontend/js/proposals/approval-review.js');
const words = require('../../frontend/js/proposals/approval-text.js');
const t = (_key, fallback, params = {}) => fallback.replace(/\{\{(\w+)\}\}/g, (match, key) => params[key] ?? match);

const owner = (ownerId, share = '1/1') => ({ ownerId, share });
const square = (x, y, size) => ({ type: 'Polygon', coordinates: [[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]] });
const threshold = (owners, area, strict = false) => ({
    type: 'threshold',
    owners: { numerator: owners[0], denominator: owners[1], strict },
    area: { numerator: area[0], denominator: area[1], strict }
});
function proposal({ policy = { type: 'unanimous' }, reparcellization = null } = {}) {
    return {
        proposalId: 'review-test',
        cadastreParcelIds: ['parcel-a', 'parcel-b', 'parcel-c'],
        approvalConfig: {
            schema: 'proposal-approval/v1',
            rights: { schema: 'parcel-rights/v1', source: { provider: 'upload' }, parcels: [
                { parcelId: 'parcel-a', complete: true, areaM2: 100, owners: [owner('owner-a')] },
                { parcelId: 'parcel-b', complete: true, areaM2: 50, owners: [owner('owner-b')] },
                { parcelId: 'parcel-c', complete: true, areaM2: 25, owners: [owner('owner-c', '1/2'), owner('owner-d', '1/2')] }
            ] },
            policy
        },
        lens: ['member-a'],
        ...(reparcellization ? { goal: 'reparcellization', reparcellization, offer: 30, offerCurrency: 'EUR', isConditional: true } : {})
    };
}

describe('owner acceptance progress', () => {
    it('reports outstanding owners and co-owned parcels that do not count until every co-owner accepts', () => {
        const progress = review.progress(proposal(), ['owner-a', 'owner-c']);
        expect(progress).toMatchObject({
            ready: true, totalOwners: 4, acceptedOwners: 2,
            totalAreaM2: 175, acceptedAreaM2: 100, passed: false, supportMet: false, authorityMet: true
        });
        // Every owner must accept: one headcount test, needing all four.
        expect(progress.tests).toEqual([expect.objectContaining({ measure: 'headcount', of: 'owners', scope: 'all', support: 2, total: 4, needed: 4, met: false })]);
        expect(progress.authorities).toEqual([]);
        expect(progress.outstanding).toEqual([
            { ownerId: 'owner-b', parcelIds: ['parcel-b'] },
            { ownerId: 'owner-d', parcelIds: ['parcel-c'] }
        ]);
        expect(progress.coOwned).toEqual([{
            parcelId: 'parcel-c', areaM2: 25, counts: false,
            owners: [{ ownerId: 'owner-c', share: '1/2', accepted: true }, { ownerId: 'owner-d', share: '1/2', accepted: false }]
        }]);
        expect(review.progress(proposal(), ['owner-a', 'owner-c', 'owner-d']).coOwned[0].counts).toBe(true);
    });

    it('computes exactly what each test still needs, strict or inclusive', () => {
        // Tests come in their canonical order (area before headcount); the UI reorders them for reading.
        const needs = (accepted, policy) => review.progress(proposal({ policy }), accepted).tests.map(test => [test.measure, test.needed, test.met]);
        expect(needs(['owner-a'], threshold([1, 2], [1, 2]))).toEqual([['area', 87.5, true], ['headcount', 2, false]]);
        expect(needs(['owner-a'], threshold([1, 2], [1, 2], true))).toEqual([['area', 87.5, true], ['headcount', 3, false]]);
        expect(needs(['owner-a'], threshold([2, 3], [1, 2]))).toEqual([['area', 87.5, true], ['headcount', 3, false]]);
        expect(needs(['owner-a'], threshold([1, 3], [1, 2], true))).toEqual([['area', 87.5, true], ['headcount', 2, false]]);
        const strict = review.progress(proposal({ policy: threshold([1, 2], [7, 10], true) }), ['owner-a']);
        expect(strict.tests.map(test => [test.needed, test.strict])).toEqual([[122.5, true], [3, true]]);
    });

    it('fails closed when ownership is unresolved', () => {
        const unresolved = proposal();
        unresolved.approvalConfig.rights.parcels[2].complete = false;
        expect(review.progress(unresolved, ['owner-a'])).toMatchObject({ ready: false, reason: 'incomplete-rights', passed: false });
        expect(review.ownerReview(unresolved, 'owner-a')).toBeNull();
    });
});

describe('owner review', () => {
    it('identifies the authored source and selected lens without claiming verified attestations', () => {
        const item = review.ownerReview(proposal(), 'owner-a');
        expect(words.reviewBasisLines(item.conditions, t, key => key === 'member-a' ? 'Selected verifier' : key)).toEqual([
            'Declared rights source: upload', 'Selected verification lens: Selected verifier'
        ]);
        expect(words.reviewBasisLines({}, t)).toEqual([
            'No rights source is specified in this record.', 'No verification lens is selected.'
        ]);
        expect(words.reviewBasisLines({ rightsSource: { provider: ' upload ', reference: ' record-9 ' } }, t)[0])
            .toBe('Declared rights source: upload · record-9');
    });

    it('shows a co-owner their share of contributed land and what their acceptance changes', () => {
        const item = review.ownerReview(proposal(), 'owner-c', { acceptedOwnerIds: ['owner-a', 'owner-b', 'owner-d'] });
        expect(item.contributes).toEqual([{ parcelId: 'parcel-c', share: '1/2', parcelAreaM2: 25, shareAreaM2: 12.5, coOwnerIds: ['owner-d'] }]);
        expect(item.contributedAreaM2).toBe(12.5);
        expect(item.receives).toBeNull();
        expect(item.alreadyAccepted).toBe(false);
        expect(item.progressWithout).toMatchObject({ acceptedOwners: 3, acceptedAreaM2: 150, passed: false });
        expect(item.progressWith).toMatchObject({ acceptedOwners: 4, acceptedAreaM2: 175, passed: true });
        expect(item.conditions).toMatchObject({ policy: { type: 'unanimous' }, lens: ['member-a'], cashOffered: false, fundingConfirmed: false });
        expect(review.ownerReview(proposal(), 'stranger')).toBeNull();
    });

    it('lists a readjustment owner’s plots, joint shares, land change and exact cash', () => {
        const item = review.ownerReview(proposal({ reparcellization: {
            polygons: [
                { geometry: square(15.98, 45.8, 0.0005), owners: [{ ownerKey: 'owner-a', share: 1 }] },
                { geometry: square(15.981, 45.8, 0.0002), owners: [{ ownerKey: 'owner-c', share: 0.5 }, { ownerKey: 'owner-d', share: 0.5 }], jointPool: true }
            ],
            ownerShares: [
                { ownerKey: 'owner-a', cashOffer: 0, contributedArea: 100 },
                { ownerKey: 'owner-c', cashOffer: 12.34, contributedArea: 12.5 },
                { ownerKey: 'owner-d', cashOffer: 17.66, contributedArea: 12.5 }
            ]
        } }), 'owner-c', { turf });
        expect(item.receives.inLedger).toBe(true);
        expect(item.receives.cashCents).toBe(1234);
        expect(item.receives.plots).toHaveLength(1);
        expect(item.receives.plots[0]).toMatchObject({ index: 1, share: 0.5, jointPool: true, coRecipientIds: ['owner-d'] });
        expect(item.receives.assignedAreaM2).toBeCloseTo(item.receives.plots[0].areaM2 / 2, 6);
        expect(item.receives.areaChangeM2).toBeCloseTo(item.receives.assignedAreaM2 - 12.5, 6);
        expect(item.conditions).toMatchObject({ isConditional: true, totalCashCents: 3000, cashOffered: true, fundingConfirmed: false });
    });

    it('says when a readjustment assigns nothing to an owner instead of guessing a match', () => {
        const item = review.ownerReview(proposal({ reparcellization: {
            polygons: [{ geometry: square(15.98, 45.8, 0.0005), owners: [{ ownerKey: 'Alice Example', share: 1 }] }],
            ownerShares: [{ ownerKey: 'Alice Example', cashOffer: 30 }]
        } }), 'owner-a', { turf });
        expect(item.receives).toMatchObject({ inLedger: false, plots: [], assignedAreaM2: 0, cashCents: 0 });
    });
});
