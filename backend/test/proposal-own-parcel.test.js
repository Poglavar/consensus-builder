// Unit tests for frontend/js/proposal-own-parcel.js — resolving the single parcel a proposal
// itself becomes, so selecting it can open that parcel's info alongside the proposal.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { childParcelIds, ownParcelId } = require('../../frontend/js/proposal-own-parcel.js');

const parcel = (id, properties = {}) => ({ type: 'Feature', properties: { parcelId: id, ...properties }, geometry: null });

// A road across three parcels: one corridor parcel plus the remainders it cut off.
const roadProposal = {
    proposalId: 'road-1',
    goal: 'road-track',
    childParcelIds: ['corridor-1', 'rem-a', 'rem-b', 'rem-c'],
    roadProposal: {}
};
const roadParcels = {
    'corridor-1': parcel('corridor-1', { isCorridor: true, isRoad: true }),
    'rem-a': parcel('rem-a'),
    'rem-b': parcel('rem-b'),
    'rem-c': parcel('rem-c')
};
const lookupRoad = id => roadParcels[id] || null;

describe('childParcelIds', () => {
    it('reads the canonical list', () => {
        expect(childParcelIds(roadProposal)).toEqual(['corridor-1', 'rem-a', 'rem-b', 'rem-c']);
    });

    it('falls back to the per-type sub-object when the canonical list is empty', () => {
        expect(childParcelIds({ childParcelIds: [], roadProposal: { childParcelIds: ['c1'] } })).toEqual(['c1']);
        expect(childParcelIds({ reparcellization: { childParcelIds: ['s1', 's2'] } })).toEqual(['s1', 's2']);
    });

    it('normalizes to unique strings', () => {
        expect(childParcelIds({ childParcelIds: [7, '7', null, undefined, 8] })).toEqual(['7', '8']);
    });

    it('returns nothing for a proposal with no children', () => {
        expect(childParcelIds({ goal: 'park' })).toEqual([]);
        expect(childParcelIds(null)).toEqual([]);
        expect(childParcelIds({ childParcelIds: 'not-an-array' })).toEqual([]);
    });
});

describe('ownParcelId', () => {
    it('picks the corridor parcel out of a road and its remainders', () => {
        expect(ownParcelId(roadProposal, lookupRoad)).toBe('corridor-1');
    });

    it('accepts the corridor flag as a string, as stored features sometimes carry it', () => {
        const lookup = id => (id === 'rem-b' ? parcel('rem-b', { isCorridor: 'true' }) : parcel(id));
        expect(ownParcelId(roadProposal, lookup)).toBe('rem-b');
    });

    it('takes the only child without needing any lookup', () => {
        expect(ownParcelId({ childParcelIds: ['merged-1'] })).toBe('merged-1');
    });

    it('returns null for a reparcellization: it is its slices, not one parcel', () => {
        const slices = { childParcelIds: ['s1', 's2', 's3'] };
        expect(ownParcelId(slices, id => parcel(id))).toBeNull();
    });

    it('returns null when a proposal creates no parcel at all', () => {
        expect(ownParcelId({ goal: 'park', parentParcelIds: ['p1'] }, lookupRoad)).toBeNull();
        expect(ownParcelId(null, lookupRoad)).toBeNull();
    });

    it('returns null when several children cannot be told apart without a lookup', () => {
        expect(ownParcelId(roadProposal, null)).toBeNull();
    });

    it('survives a lookup that throws or returns nothing', () => {
        expect(ownParcelId(roadProposal, () => { throw new Error('gone'); })).toBeNull();
        expect(ownParcelId(roadProposal, () => null)).toBeNull();
    });
});
