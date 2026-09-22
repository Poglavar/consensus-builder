import { describe, expect, it } from 'vitest';
import { buildParcelSet } from '../proposals/parcel-set.js';

describe('canonical parcel-set identity', () => {
    it('gives the same jurisdictional set the same hash regardless of input order', () => {
        const first = buildParcelSet({
            jurisdiction: 'zagreb', parcelIds: ['HR-335550-1813/3', 'HR-335550-1813/2'],
            referenceAt: '2026-09-22T08:00:00Z'
        });
        const second = buildParcelSet({
            jurisdiction: 'zagreb', parcelIds: ['HR-335550-1813/2', 'HR-335550-1813/3'],
            referenceAt: '2027-01-01T00:00:00Z'
        });
        expect(first).toMatchObject({
            parcelIds: ['HR-335550-1813/2', 'HR-335550-1813/3'], parcelCount: 2,
            authority: 'Croatian State Geodetic Administration'
        });
        expect(first.setHash).toBe(second.setHash);
        expect(first.referenceAt).not.toBe(second.referenceAt);
    });

    it('changes identity across jurisdictions even when local parcel ids match', () => {
        const left = buildParcelSet({ jurisdiction: 'zagreb', parcelIds: ['123/4'] });
        const right = buildParcelSet({ jurisdiction: 'split', parcelIds: ['123/4'] });
        expect(left.setHash).not.toBe(right.setHash);
    });
});
