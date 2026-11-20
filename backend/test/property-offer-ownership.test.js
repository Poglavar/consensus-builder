// Registry identity mapping retains source and snapshot boundaries.
import { describe, expect, it, vi } from 'vitest';
import { readOwnership, registryParcelKey } from '../property-offers/ownership.js';
import { parcelUid } from '../lens/property-offer-decision.js';

describe('property offer ownership identity mapping', () => {
    it('maps only current oss-wfs HR references to the raw official registry ID and restores canonical offer keys', async () => {
        const current = { sourceId: 'oss-wfs', id: 'HR-335258-4341/2' };
        const snapshot = { ...current, snapshotId: '2026-01' };
        const other = { sourceId: 'other-source', id: current.id };
        const owner = { owner: 'wallet', ownerCount: 1, establishedAt: 10 };
        const ownerSets = vi.fn(async keys => new Map([[current.id, [owner]], [parcelUid(snapshot), [{ owner: 'snapshot-owner' }]], [parcelUid(other), [{ owner: 'other-owner' }]]]));
        const result = await readOwnership([current, snapshot, other], { ownerSets });

        expect(ownerSets).toHaveBeenCalledWith([current.id, parcelUid(snapshot), parcelUid(other)]);
        expect(registryParcelKey(current)).toBe(current.id);
        expect(registryParcelKey(snapshot)).toBe(parcelUid(snapshot));
        expect(registryParcelKey(other)).toBe(parcelUid(other));
        expect([...result.keys()]).toEqual([parcelUid(current), parcelUid(snapshot), parcelUid(other)]);
        expect(result.get(parcelUid(current))).toEqual([owner]);
        expect(result.get(parcelUid(snapshot))).toEqual([{ owner: 'snapshot-owner' }]);
        expect(result.get(parcelUid(other))).toEqual([{ owner: 'other-owner' }]);
    });

    it('preserves complete multiple-owner sets and distinct parcels', async () => {
        const refs = [{ sourceId: 'oss-wfs', id: 'HR-1-1/1' }, { sourceId: 'oss-wfs', id: 'HR-1-1/2' }];
        const owners = [{ owner: 'a', ownerCount: 2 }, { owner: 'b', ownerCount: 2 }];
        const result = await readOwnership(refs, { ownerSets: async keys => new Map([[keys[0], owners], [keys[1], [{ owner: 'c', ownerCount: 1 }]]]) });
        expect(result.get(parcelUid(refs[0]))).toEqual(owners);
        expect(result.get(parcelUid(refs[1]))).toEqual([{ owner: 'c', ownerCount: 1 }]);
    });

    it('does not map malformed, unknown-provenance or non-HR references to bare IDs', async () => {
        const refs = [{ sourceId: 'oss-wfs', id: 'same' }, { sourceId: 'unknown-source', id: 'same' }];
        const ownerSets = vi.fn(async () => new Map());
        await readOwnership(refs, { ownerSets });
        expect(ownerSets).toHaveBeenCalledWith(refs.map(parcelUid));
        expect(registryParcelKey({ sourceId: 'oss-wfs', id: 'HR-x-1' })).not.toBe('HR-x-1');
    });

    it('rejects duplicate canonical refs before querying', async () => {
        const ref = { sourceId: 'oss-wfs', id: 'HR-1-1/1' };
        const ownerSets = vi.fn();
        await expect(readOwnership([ref, { ...ref, snapshotId: null }], { ownerSets })).rejects.toThrow(/Duplicate canonical/);
        expect(ownerSets).not.toHaveBeenCalled();
    });
});
