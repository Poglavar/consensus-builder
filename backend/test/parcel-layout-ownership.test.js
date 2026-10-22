// Unit tests for frontend/js/parcel-layout-ownership.js: the holders of a formed piece are the
// recorded owners of the ground under it, pro rata by area, merged per owner, without slivers, and
// the part of the piece no owned parcel covers is reported as open ground.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const { ownersOf, MIN_SHARE, DEFAULT_MIN_OVERLAP_M2 } = require('../../frontend/js/parcel-layout-ownership.js');

// Rectangles near Zagreb in units of 1e-3 degree (≈ 78 m east, 111 m north).
function rect(x0, y0, x1, y1) {
    const LON = 15.96, LAT = 45.80;
    return {
        type: 'Polygon',
        coordinates: [[
            [LON + x0 * 1e-3, LAT + y0 * 1e-3], [LON + x1 * 1e-3, LAT + y0 * 1e-3],
            [LON + x1 * 1e-3, LAT + y1 * 1e-3], [LON + x0 * 1e-3, LAT + y1 * 1e-3],
            [LON + x0 * 1e-3, LAT + y0 * 1e-3]
        ]]
    };
}
const parcel = (id, geometry) => ({ type: 'Feature', properties: { parcelId: id }, geometry });
const owners = { A: { ownerKey: 'agent-ana', displayName: 'Ana' }, B: { ownerKey: 'agent-boris', displayName: 'Boris' } };
// Parcels A1, A2 belong to Ana, B to Boris; anything else has no recorded owner.
const ownerOf = source => ({ A1: owners.A, A2: owners.A, B: owners.B })[source.properties.parcelId] || null;
const options = { turf };

describe('ownersOf', () => {
    it('gives a piece inside one parcel to that parcel\'s owner alone', () => {
        const result = ownersOf(rect(0.5, 0.5, 1.5, 1.5), [parcel('A1', rect(0, 0, 2, 2)), parcel('B', rect(2, 0, 4, 2))], ownerOf, options);
        expect(result.owners).toEqual([{ ownerKey: 'agent-ana', displayName: 'Ana', share: 1 }]);
        expect(result.openGroundShare).toBeCloseTo(0, 9);
    });

    it('shares a straddling piece pro rata by the overlap with each parcel, largest first', () => {
        const result = ownersOf(rect(1, 0, 4, 2), [parcel('A1', rect(0, 0, 2, 2)), parcel('B', rect(2, 0, 4, 2))], ownerOf, options);
        expect(result.owners.map(owner => owner.ownerKey)).toEqual(['agent-boris', 'agent-ana']);
        expect(result.owners[0].share).toBeCloseTo(2 / 3, 9);
        expect(result.owners[1].share).toBeCloseTo(1 / 3, 9);
        expect(result.owners.reduce((sum, owner) => sum + owner.share, 0)).toBeCloseTo(1, 12);
    });

    it('merges an owner who holds several of the parcels', () => {
        const sources = [parcel('A1', rect(0, 0, 1, 2)), parcel('A2', rect(1, 0, 2, 2)), parcel('B', rect(2, 0, 4, 2))];
        const result = ownersOf(rect(0, 0, 3, 2), sources, ownerOf, options);
        expect(result.owners).toHaveLength(2);
        expect(result.owners[0]).toMatchObject({ ownerKey: 'agent-ana', displayName: 'Ana' });
        expect(result.owners[0].share).toBeCloseTo(2 / 3, 9);
        expect(result.owners[1].share).toBeCloseTo(1 / 3, 9);
    });

    it('drops a holder under half a percent of the owned ground and renormalises the rest', () => {
        // Boris's parcel reaches 0.006 units (≈ 0.3 % of the piece, about 100 m²) into it.
        const sources = [parcel('A1', rect(0, 0, 1.994, 2)), parcel('B', rect(1.994, 0, 4, 2))];
        const result = ownersOf(rect(0, 0, 2, 2), sources, ownerOf, options);
        expect(MIN_SHARE).toBe(0.005);
        expect(result.owners).toEqual([{ ownerKey: 'agent-ana', displayName: 'Ana', share: 1 }]);
        expect(result.openGroundShare).toBeCloseTo(0, 9);
        // Just over the limit, Boris stays a co-owner.
        const kept = ownersOf(rect(0, 0, 2, 2), [parcel('A1', rect(0, 0, 1.985, 2)), parcel('B', rect(1.985, 0, 4, 2))], ownerOf, options);
        expect(kept.owners.map(owner => owner.ownerKey)).toEqual(['agent-ana', 'agent-boris']);
        expect(kept.owners[1].share).toBeCloseTo(0.0075, 6);
    });

    it('reports the part no owned parcel covers as open ground, and shares the owned part only', () => {
        // Half on Ana's parcel, half on a parcel with no recorded owner.
        const result = ownersOf(rect(1, 0, 3, 2), [parcel('A1', rect(0, 0, 2, 2)), parcel('C', rect(2, 0, 4, 2))], ownerOf, options);
        expect(result.owners).toEqual([{ ownerKey: 'agent-ana', displayName: 'Ana', share: 1 }]);
        expect(result.openGroundShare).toBeCloseTo(0.5, 9);
        // Half on Ana's parcel, half on no parcel at all.
        expect(ownersOf(rect(1, 0, 3, 2), [parcel('A1', rect(0, 0, 2, 2))], ownerOf, options).openGroundShare).toBeCloseTo(0.5, 9);
    });

    it('gives a piece on open ground alone no holder', () => {
        const result = ownersOf(rect(4, 0, 5, 2), [parcel('C', rect(4, 0, 6, 2))], ownerOf, options);
        expect(result).toEqual({ owners: [], openGroundShare: 1 });
        expect(ownersOf(rect(4, 0, 5, 2), [], ownerOf, options)).toEqual({ owners: [], openGroundShare: 1 });
    });

    it('does not count a parcel that only touches the piece or reaches in by less than the anchor floor', () => {
        expect(DEFAULT_MIN_OVERLAP_M2).toBe(1);
        // Ana's parcel only touches the piece along x = 2.
        const touching = ownersOf(rect(2, 0, 3, 2), [parcel('A1', rect(0, 0, 2, 2)), parcel('B', rect(2, 0, 4, 2))], ownerOf, options);
        expect(touching.owners).toEqual([{ ownerKey: 'agent-boris', displayName: 'Boris', share: 1 }]);
        // Boris's parcel reaches into the piece by a sliver: ≈ 1.6 mm × 222 m ≈ 0.35 m².
        const sliver = [parcel('B', rect(2 - 2e-5, 0, 4, 2))];
        const reached = ownersOf(rect(0, 0, 2, 2), sliver, ownerOf, options);
        expect(reached.owners).toEqual([]);
        expect(reached.openGroundShare).toBeCloseTo(1, 6);
        // Without the floor the sliver would make Boris the holder of the whole piece.
        expect(ownersOf(rect(0, 0, 2, 2), sliver, ownerOf, { turf, minOverlapM2: 0 }).owners)
            .toEqual([{ ownerKey: 'agent-boris', displayName: 'Boris', share: 1 }]);
    });

    it('uses an injected measure, skips parcels whose boxes miss the piece, and orders equal shares by owner key', () => {
        const intersectionArea = vi.fn(() => 10);
        const sources = [parcel('B', rect(1, 0, 2, 2)), parcel('A1', rect(0, 0, 1, 2)), parcel('far', rect(10, 10, 11, 11))];
        const lookup = source => (source.properties.parcelId === 'far' ? owners.B : ownerOf(source));
        const result = ownersOf(rect(0, 0, 2, 2), sources, lookup, { turf, intersectionArea, area: () => 20 });
        expect(intersectionArea).toHaveBeenCalledTimes(2);
        expect(result).toEqual({
            owners: [{ ownerKey: 'agent-ana', displayName: 'Ana', share: 0.5 }, { ownerKey: 'agent-boris', displayName: 'Boris', share: 0.5 }],
            openGroundShare: 0
        });
    });

    it('fails loudly on a malformed lookup or measure instead of guessing a holder', () => {
        const sources = [parcel('A1', rect(0, 0, 2, 2))];
        expect(() => ownersOf(rect(0, 0, 1, 1), sources, null, options)).toThrow(/ownerOf/);
        expect(() => ownersOf(rect(0, 0, 1, 1), sources, () => ({ displayName: 'Nobody' }), options)).toThrow(/without an ownerKey/);
        expect(() => ownersOf(rect(0, 0, 1, 1), sources, ownerOf, { turf, intersectionArea: () => NaN })).toThrow(/could not be measured/);
        expect(() => ownersOf(null, sources, ownerOf, options)).toThrow(/polygon piece/);
        expect(() => ownersOf(rect(0, 0, 1, 1), sources, ownerOf, {})).toThrow(/needs turf/);
    });

    it('falls back to the owner key when the lookup has no display name', () => {
        const result = ownersOf(rect(0, 0, 1, 1), [parcel('X', rect(0, 0, 2, 2))], () => ({ ownerKey: 'agent-x' }), options);
        expect(result.owners).toEqual([{ ownerKey: 'agent-x', displayName: 'agent-x', share: 1 }]);
    });
});
