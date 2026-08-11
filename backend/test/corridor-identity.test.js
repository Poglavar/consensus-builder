// Is this ground a corridor?
//
// A flood fill that can walk down a road joins the blocks on both sides of the street into one, and
// the merged thing then measures the far kerb as part of its own outline and fails every enclosure
// test. The way that happens in practice is not a flag anyone forgot to set: it is a piece id. The
// road set is keyed by cadastral parcel, so the strip left over when one of our corridors clips an
// existing street — 'HR-123#a4f9c1' — is in no set and carries no corridor flag of its own.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isCorridorGround, ancestryOf } = require('../../frontend/js/parcels/corridor-identity.js');

const roadSet = ids => id => ids.includes(id);

describe('a piece of a road is still a road', () => {
    it('recognises a remainder by the parcel it was cut from', () => {
        const answer = isCorridorGround({
            parcelId: 'HR-330264-123#a4f9c1',
            properties: { baseParcelIds: ['HR-330264-123'] },
            isRoadInSet: roadSet(['HR-330264-123'])
        });

        // Asking the set about the piece id alone answers false here, and the fill walks the street.
        expect(answer).toBe(true);
    });

    it('recognises it from the id alone when it records no ancestry', () => {
        expect(isCorridorGround({
            parcelId: 'HR-330264-123#a4f9c1',
            properties: {},
            isRoadInSet: roadSet(['HR-330264-123'])
        })).toBe(true);
    });

    it('still answers for an uncut road parcel', () => {
        expect(isCorridorGround({
            parcelId: 'HR-330264-123',
            properties: {},
            isRoadInSet: roadSet(['HR-330264-123'])
        })).toBe(true);
    });

    it('leaves ordinary ground alone', () => {
        expect(isCorridorGround({
            parcelId: 'HR-330264-519#b2c3',
            properties: { baseParcelIds: ['HR-330264-519'] },
            isRoadInSet: roadSet(['HR-330264-123'])
        })).toBe(false);
    });

    it('does not invent an ancestor out of a plain id', () => {
        expect(ancestryOf('HR-330264-519', {})).toEqual(['HR-330264-519']);
        expect(ancestryOf('HR-330264-519#b2c3', { rootParcelId: 'HR-330264-519' }))
            .toEqual(['HR-330264-519#b2c3', 'HR-330264-519']);
    });
});

describe('the flags that answer on their own', () => {
    it('takes a corridor piece from its own properties', () => {
        expect(isCorridorGround({ parcelId: 'x', properties: { isCorridor: true } })).toBe(true);
        expect(isCorridorGround({ parcelId: 'x', properties: { isTrack: true } })).toBe(true);
    });

    it('takes isRoad, which travels onto a remainder from the parcel it was cut from', () => {
        expect(isCorridorGround({ parcelId: 'x#1', properties: { isRoad: true } })).toBe(true);
    });

    it('reads the persisted record when nothing else answers', () => {
        expect(isCorridorGround({
            parcelId: 'x',
            properties: {},
            persistedProperties: { isTrack: true }
        })).toBe(true);
    });

    it('does not touch storage when a cheaper check already answered', () => {
        // Once per parcel in a flood fill, and the persisted record is a read rather than a field.
        const read = vi.fn(() => ({ isCorridor: true }));

        expect(isCorridorGround({
            parcelId: 'x',
            properties: { isCorridor: true },
            persistedProperties: read
        })).toBe(true);
        expect(read).not.toHaveBeenCalled();

        expect(isCorridorGround({
            parcelId: 'x',
            properties: {},
            persistedProperties: read
        })).toBe(true);
        expect(read).toHaveBeenCalledTimes(1);
    });

    it('survives a road set that throws', () => {
        expect(isCorridorGround({
            parcelId: 'x',
            properties: {},
            isRoadInSet: () => { throw new Error('storage is not ready'); }
        })).toBe(false);
    });
});
