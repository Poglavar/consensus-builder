import { describe, expect, it } from 'vitest';
import { buildParcelSet } from '../proposals/parcel-set.js';

describe('canonical parcel-set identity', () => {
    it('gives the same jurisdictional set the same hash regardless of input order', () => {
        const first = buildParcelSet({
            jurisdiction: 'city-a', parcelIds: ['HR-335550-1813/3', 'HR-335550-1813/2']
        });
        const second = buildParcelSet({
            jurisdiction: 'city-a', parcelIds: ['HR-335550-1813/2', 'HR-335550-1813/3']
        });
        expect(first).toMatchObject({
            parcelIds: ['HR-335550-1813/2', 'HR-335550-1813/3'], parcelCount: 2,
            authority: null
        });
        expect(first.setHash).toBe(second.setHash);
        expect(Object.keys(first).sort()).toEqual(['authority', 'jurisdiction', 'parcelCount', 'parcelIds', 'setHash']);
    });

    it('changes identity across jurisdictions even when local parcel ids match', () => {
        const left = buildParcelSet({ jurisdiction: 'city-a', parcelIds: ['123/4'] });
        const right = buildParcelSet({ jurisdiction: 'city-b', parcelIds: ['123/4'] });
        expect(left.setHash).not.toBe(right.setHash);
    });

    it('keeps authority and jurisdiction unknown unless explicitly supplied', () => {
        for (const parcelIds of [['HR-1-1'], ['provider-1'], []]) {
            expect(buildParcelSet({ parcelIds })).toMatchObject({ authority: null, jurisdiction: null });
        }
        const unknown = buildParcelSet({ parcelIds: ['1'] });
        const known = buildParcelSet({ parcelIds: ['1'], authority: 'register-a' });
        expect(known.authority).toBe('register-a');
        expect(known.setHash).not.toBe(unknown.setHash);
        expect(buildParcelSet({ parcelIds: ['1'], authority: 'register-b' }).setHash).not.toBe(known.setHash);
        expect(() => buildParcelSet({ authority: { name: 'register-a' } })).toThrow('authority must be a string or null');
        expect(() => buildParcelSet({ jurisdiction: 1 })).toThrow('jurisdiction must be a string or null');
    });
});
