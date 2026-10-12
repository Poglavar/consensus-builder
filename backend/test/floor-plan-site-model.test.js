// Site-model helpers: one identity per site across postings, plan outlines in metres, north as rotation.
import { describe, expect, it } from 'vitest';
import { northRotationDeg, planOutline, siteKey } from '../floor-plans/site-model.js';

describe('site model helpers', () => {
    it('identifies a site by permit case first, then address point, then parcels', () => {
        expect(siteKey({ permits: [{ caseId: 'P1' }], addressPoints: [{ id: 'A' }] })).toBe('permit:P1');
        expect(siteKey({ permits: [], addressPoints: [{ id: 'A' }] })).toBe('address:A');
        expect(siteKey({ parcels: [{ ko: '2', kc: '9' }, { ko: '1', kc: '5' }] })).toBe('parcels:1:5,2:9');
        expect(siteKey({})).toBeNull();
    });

    it('turns the normalized slab ring into metres with y pointing north', () => {
        const model = { architecture: { dimensionsM: [10, 8], slabs: [[[[0, 0], [1, 0], [1, 1], [0, 1]]]] } };
        expect(planOutline(model)).toEqual([[0, -0], [10, -0], [10, -8], [0, -8]]);
        expect(planOutline({ architecture: { dimensionsM: [0, 8], slabs: [] } })).toBeNull();
    });

    it('reads a printed north arrow as the rotation that points it up', () => {
        expect(northRotationDeg({ source: { northPx: [[50, 60], [50, 10]] } })).toBeCloseTo(0, 6);   // arrow already up
        expect(northRotationDeg({ source: { northPx: [[10, 50], [60, 50]] } })).toBeCloseTo(90, 6);  // arrow points right
        expect(northRotationDeg({ source: { northPx: null } })).toBeNull();
    });
});
