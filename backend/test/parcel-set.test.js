import { describe, expect, it } from 'vitest';
import { buildParcelSet, normalizeParcelSource } from '../proposals/parcel-set.js';

describe('canonical parcel-set identity', () => {
    it('gives the same source-qualified set the same hash regardless of input order', () => {
        const source = { sourceId: 'register-a', snapshotId: null };
        const first = buildParcelSet({
            jurisdiction: 'city-a', parcelSource: source,
            parcelIds: ['HR-335550-1813/3', 'HR-335550-1813/2']
        });
        const second = buildParcelSet({
            jurisdiction: 'city-a', parcelSource: source,
            parcelIds: ['HR-335550-1813/2', 'HR-335550-1813/3']
        });
        expect(first).toMatchObject({
            parcelIds: ['HR-335550-1813/2', 'HR-335550-1813/3'], parcelCount: 2,
            authority: null, parcelSource: source
        });
        expect(first.setHash).toBe(second.setHash);
        expect(Object.keys(first).sort()).toEqual(['authority', 'jurisdiction', 'parcelCount', 'parcelIds', 'parcelSource', 'setHash']);
    });

    it('changes identity across providers and pinned snapshots when parcel ids match', () => {
        const left = buildParcelSet({ parcelSource: { sourceId: 'register-a', snapshotId: null }, parcelIds: ['123/4'] });
        const otherProvider = buildParcelSet({ parcelSource: { sourceId: 'register-b', snapshotId: null }, parcelIds: ['123/4'] });
        const snapshotA = buildParcelSet({ parcelSource: { sourceId: 'register-a', snapshotId: 'snapshot-a' }, parcelIds: ['123/4'] });
        const snapshotB = buildParcelSet({ parcelSource: { sourceId: 'register-a', snapshotId: 'snapshot-b' }, parcelIds: ['123/4'] });
        expect(left.setHash).not.toBe(otherProvider.setHash);
        expect(snapshotA.setHash).not.toBe(snapshotB.setHash);
        expect(snapshotA.setHash).not.toBe(left.setHash);
    });

    it('keeps jurisdiction and authority labels out of reference identity', () => {
        const first = buildParcelSet({
            parcelSource: { sourceId: 'register-a', snapshotId: null }, parcelIds: ['123/4'],
            jurisdiction: 'city-a', authority: 'publisher-a'
        });
        const labelsChanged = buildParcelSet({
            parcelSource: { sourceId: 'register-a', snapshotId: null }, parcelIds: ['123/4'],
            jurisdiction: 'city-b', authority: 'publisher-b'
        });
        expect(labelsChanged).toMatchObject({ jurisdiction: 'city-b', authority: 'publisher-b' });
        expect(labelsChanged.setHash).toBe(first.setHash);
    });

    it('keeps unknown source and labels null unless explicitly supplied', () => {
        for (const parcelIds of [['HR-1-1'], ['provider-1'], []]) {
            expect(buildParcelSet({ parcelIds })).toMatchObject({
                authority: null, jurisdiction: null, parcelSource: null
            });
        }
        const unknown = buildParcelSet({ parcelIds: ['1'] });
        const known = buildParcelSet({
            parcelIds: ['1'], parcelSource: { sourceId: 'register-a', snapshotId: null }
        });
        expect(known.setHash).not.toBe(unknown.setHash);
    });

    it('rejects malformed supplied source values', () => {
        expect(normalizeParcelSource(null)).toBeNull();
        expect(normalizeParcelSource({ sourceId: ' register-a ', snapshotId: null }))
            .toEqual({ sourceId: 'register-a', snapshotId: null });
        for (const value of ['register-a', {}, { sourceId: '' }, { sourceId: 4 },
            { sourceId: 'register-a', snapshotId: '' }, { sourceId: 'register-a', snapshotId: 2 },
            { sourceId: 'register-a', snapshotId: null, countryCode: 'HR' }]) {
            expect(() => buildParcelSet({ parcelIds: ['1'], parcelSource: value })).toThrow();
        }
        expect(() => buildParcelSet({ authority: { name: 'register-a' } })).toThrow('authority must be a string or null');
        expect(() => buildParcelSet({ jurisdiction: 1 })).toThrow('jurisdiction must be a string or null');
    });
});
