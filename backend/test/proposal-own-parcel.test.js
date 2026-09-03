// Unit tests for frontend/js/proposal-own-parcel.js — resolving the single parcel a proposal
// itself becomes, so selecting it can open that parcel's info alongside the proposal.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { materializedParcelIds, ownParcelId } = require('../../frontend/js/proposal-own-parcel.js');

const parcel = (id, properties = {}) => ({ type: 'Feature', properties: { parcelId: id, ...properties }, geometry: null });

// A road across three parcels: one corridor parcel plus the remainders it cut off.
const roadProposal = {
    proposalId: 'road-1',
    goal: 'road-track',
    cadastreParcelIds: ['HR-1-1', 'HR-1-2'],
    roadProposal: {}
};
const roadParcels = [
    parcel('corridor-1', { isCorridor: true, isRoad: true }),
    parcel('rem-a'),
    parcel('rem-b'),
    parcel('rem-c')
];

describe('materializedParcelIds', () => {
    it('reads unique IDs from the live materialization, not the proposal', () => {
        expect(materializedParcelIds([parcel(7), parcel('7'), null, parcel(8)]))
            .toEqual(['7', '8']);
    });

    it('returns nothing when no live materialization was supplied', () => {
        expect(materializedParcelIds()).toEqual([]);
        expect(materializedParcelIds('not-an-array')).toEqual([]);
    });
});

describe('ownParcelId', () => {
    it('picks the corridor parcel out of a road and its remainders', () => {
        expect(ownParcelId(roadProposal, roadParcels)).toBe('corridor-1');
    });

    it('accepts the corridor flag as a string, as stored features sometimes carry it', () => {
        const features = [parcel('rem-a'), parcel('rem-b', { isCorridor: 'true' }), parcel('rem-c')];
        expect(ownParcelId(roadProposal, features)).toBe('rem-b');
    });

    it('takes the only live output', () => {
        expect(ownParcelId({ proposalId: 'merge' }, [parcel('merged-1')])).toBe('merged-1');
    });

    it('returns null for a reparcellization: it is its slices, not one parcel', () => {
        const slices = [parcel('s1'), parcel('s2'), parcel('s3')];
        expect(ownParcelId({ proposalId: 'reparcel' }, slices)).toBeNull();
    });

    it('returns null when a proposal creates no parcel at all', () => {
        expect(ownParcelId({ goal: 'park', cadastreParcelIds: ['p1'] }, [])).toBeNull();
        expect(ownParcelId(null, roadParcels)).toBeNull();
    });

    it('returns null when several outputs are not a corridor', () => {
        expect(ownParcelId(roadProposal, [parcel('a'), parcel('b')])).toBeNull();
    });
});
