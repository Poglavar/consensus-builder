import { describe, expect, it } from 'vitest';
import * as turf from '@turf/turf';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const allocation = require('../../frontend/js/reparcellization-allocation.js');

const square = (x1, y1, x2, y2) => turf.polygon([[
    [x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]
]]).geometry;

describe('reparcellization allocation helpers', () => {
    it('parses exact 70/30 recipient percentages and preserves metadata', () => {
        expect(allocation.parsePercentShares([
            { ownerKey: 'a', displayName: 'A', color: '#112233', percent: '70' },
            { ownerKey: 'b', displayName: 'B', color: '#445566', percent: '30.0' }
        ])).toEqual([
            { ownerKey: 'a', displayName: 'A', color: '#112233', share: 0.7 },
            { ownerKey: 'b', displayName: 'B', color: '#445566', share: 0.30000000000000004 }
        ]);
    });

    it('allows equal thirds within floating point tolerance', () => {
        const shares = allocation.parsePercentShares([
            { ownerKey: 'a', percent: '33.3333333333333' },
            { ownerKey: 'b', percent: '33.3333333333333' },
            { ownerKey: 'c', percent: '33.3333333333334' }
        ]);
        expect(shares.map(owner => owner.share)).toEqual([
            0.333333333333333, 0.333333333333333, expect.closeTo(0.333333333333334, 15)
        ]);
        expect(shares.reduce((sum, owner) => sum + owner.share, 0)).toBeCloseTo(1, 15);
    });

    it('rejects a positive last percentage that rounds away after earlier shares', () => {
        expect(() => allocation.parsePercentShares([
            { ownerKey: 'a', percent: 100 },
            { ownerKey: 'b', percent: '0.00000000000000000001' }
        ])).toThrow(/positive shares/i);
    });

    it.each([
        [[{ ownerKey: 'a', percent: '60' }, { ownerKey: 'b', percent: '30' }]],
        [[{ ownerKey: 'a', percent: '100' }, { ownerKey: 'a', percent: '0' }]],
        [[{ ownerKey: 'a', percent: '0' }, { ownerKey: 'b', percent: '100' }]],
        [[{ ownerKey: 'a', percent: '' }, { ownerKey: 'b', percent: '100' }]],
        [[{ ownerKey: 'a', percent: 'NaN' }, { ownerKey: 'b', percent: '100' }]],
        [[{ ownerKey: 'a', percent: '1e2' }]],
        [[{ ownerKey: 'a', percent: 100.01 }]],
    ])('rejects invalid percentage rows %#', rows => {
        expect(() => allocation.parsePercentShares(rows)).toThrow();
    });

    it('reports per-owner impact across private and joint plots in square metres', () => {
        const plots = [
            { geometry: square(0, 0, 0.001, 0.001), owners: [{ ownerKey: 'a', share: 1 }], jointPool: false },
            { geometry: square(1, 0, 1.002, 0.001), owners: [{ ownerKey: 'a', share: 0.7 }, { ownerKey: 'b', share: 0.3 }], jointPool: true },
            { geometry: square(2, 0, 2.001, 0.001), owners: [{ ownerKey: 'b', share: 1 }], jointPool: false }
        ];
        const original = structuredClone(plots);
        const impact = allocation.ownerImpact({ ownerKey: 'a', contributedArea: 80, cashOffer: 12.34 }, plots, turf);
        const area0 = turf.area(turf.feature(plots[0].geometry));
        const area1 = turf.area(turf.feature(plots[1].geometry));

        expect(impact.ownerKey).toBe('a');
        expect(impact.contributedAreaM2).toBe(80);
        expect(impact.plots).toHaveLength(2);
        expect(impact.plots.map(plot => plot.index)).toEqual([0, 1]);
        expect(impact.plots[0]).toMatchObject({ share: 1, jointPool: false });
        expect(impact.plots[1]).toMatchObject({ share: 0.7, jointPool: true });
        expect(impact.plots[0].areaM2).toBeCloseTo(area0, 5);
        expect(impact.plots[1].areaM2).toBeCloseTo(area1, 5);
        expect(impact.assignedAreaM2).toBeCloseTo(area0 + area1 * 0.7, 5);
        expect(impact.areaChangeM2).toBeCloseTo(area0 + area1 * 0.7 - 80, 5);
        expect(impact.cashOfferCents).toBe(1234);
        expect(plots).toEqual(original);
    });

    it('keeps unresolved or explicitly null measurements unknown and defaults absent cash to zero', () => {
        const plot = { geometry: square(0, 0, 0.001, 0.001), owners: [{ ownerKey: 'a', share: 1 }] };
        expect(allocation.ownerImpact({ ownerKey: 'a', unresolvedContribution: true }, [plot], turf))
            .toMatchObject({ contributedAreaM2: null, areaChangeM2: null, cashOfferCents: 0 });
        expect(allocation.ownerImpact({ ownerKey: 'a' }, [plot], turf))
            .toMatchObject({ contributedAreaM2: null, areaChangeM2: null, cashOfferCents: 0 });
        expect(allocation.ownerImpact({ ownerKey: 'a', contributedArea: null, area: 50 }, [plot], turf))
            .toMatchObject({ contributedAreaM2: null, areaChangeM2: null });
        expect(allocation.ownerImpact({ ownerKey: 'a', area: 50 }, [plot], turf).contributedAreaM2).toBe(50);
        expect(() => allocation.ownerImpact({ ownerKey: 'a', contributedArea: -1 }, [plot], turf))
            .toThrow(/cannot be negative/i);
    });

    it('uses shared ownership validation for multi-owner fractions and singular ownerKey plots', () => {
        const geometry = square(0, 0, 1, 1);
        const tolerated = allocation.ownerImpact({ ownerKey: 'a' }, [{
            geometry, owners: [{ ownerKey: 'a', share: 0.9999995 }, { ownerKey: 'b', share: 0.0000005 }]
        }], turf);
        expect(tolerated.plots[0].share).toBeCloseTo(0.9999995, 12);

        const singular = allocation.ownerImpact({ ownerKey: 'a' }, [{ geometry, ownerKey: 'a' }], turf);
        expect(singular.plots).toHaveLength(1);
        expect(singular.plots[0].share).toBe(1);

        const unassigned = allocation.ownerImpact({ ownerKey: 'a' }, [{ geometry, owners: [] }], turf);
        expect(unassigned.plots).toEqual([]);
        expect(unassigned.assignedAreaM2).toBe(0);

        expect(() => allocation.ownerImpact({ ownerKey: 'a' }, [
            { geometry, owners: [{ ownerKey: 'a', share: 0 }] }
        ], turf)).toThrow(/share/i);
        expect(() => allocation.ownerImpact({ ownerKey: 'a' }, [
            { geometry, owners: [{ ownerKey: 'a', share: 0.4 }, { ownerKey: 'b', share: 0.4 }] }
        ], turf)).toThrow(/sum to 1/i);
        expect(() => allocation.ownerImpact({ ownerKey: 'a' }, [
            { geometry: { type: 'Polygon', coordinates: [] }, owners: [] }
        ], turf)).toThrow(/geometry/i);
    });
});
