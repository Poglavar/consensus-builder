// formation-edit.js — the pure engine that makes a formation edit a PARTITION edit instead of a
// new generation: piece matching (identity carry-over), changed-ground delta (scoped disclosure),
// carried-identity application, and the retained-unloaded-parents rule (the self-ghost fix).
// Real turf drives the injected ctx, so the tolerances are exercised on real geodesic areas.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const fe = require('../../frontend/js/proposals/formation-edit.js');

const ctx = {
    area: f => turf.area(f),
    intersectionArea: (a, b) => {
        const hit = turf.intersect(a, b);
        return hit ? turf.area(hit) : 0;
    },
    difference: (a, b) => turf.difference(a, b)
};

// Axis-aligned lon/lat rectangle around Zagreb (~45.8N): 0.00001° lon ≈ 0.78 m, lat ≈ 1.11 m.
function rect(lonMin, latMin, lonMax, latMax) {
    return {
        type: 'Feature', properties: {}, geometry: {
            type: 'Polygon',
            coordinates: [[[lonMin, latMin], [lonMax, latMin], [lonMax, latMax], [lonMin, latMax], [lonMin, latMin]]]
        }
    };
}

const LON = 15.96, LAT = 45.80;
// ~78 m × ~111 m block
const block = (dx0, dy0, dx1, dy1) => rect(LON + dx0 * 1e-3, LAT + dy0 * 1e-3, LON + dx1 * 1e-3, LAT + dy1 * 1e-3);

describe('baseIdOf', () => {
    it('strips derivation suffixes to the cadastral root, however deep', () => {
        expect(fe.baseIdOf('HR-339270-823/1')).toBe('HR-339270-823/1');
        expect(fe.baseIdOf('HR-339270-823/1#c-road-2')).toBe('HR-339270-823/1');
        expect(fe.baseIdOf('HR-339270-823/1#a-1#b-2')).toBe('HR-339270-823/1');
        expect(fe.baseIdOf(null)).toBe('');
    });
});

describe('sameGround', () => {
    it('accepts identical ground and rejects a clearly different shape', () => {
        const a = block(0, 0, 1, 1);
        expect(fe.sameGround(a, block(0, 0, 1, 1), ctx)).toBe(true);
        expect(fe.sameGround(a, block(0.5, 0, 1.5, 1), ctx)).toBe(false);
    });

    it('tolerates vertex noise but not a real reshape', () => {
        const a = block(0, 0, 1, 1);
        const noisy = block(0.000005, 0, 1.000005, 1); // ~0.4 m shift on a ~78 m side
        expect(fe.sameGround(a, noisy, ctx)).toBe(true);
    });
});

describe('matchPieces', () => {
    const P = 'HR-339270-823/1';

    it('carries identity for untouched pieces, classifies grown remainders as reshaped, mints the rest', () => {
        // Before: corridor strip + two remainders (north, south). After: the road narrowed — the
        // corridor thins, the north remainder grows, the south remainder is untouched, and a new
        // pocket appears on a second base parcel.
        const before = [
            { id: `${P}#c-r-1`, number: '823/1#c-r-1', baseId: P, isCorridor: true, feature: block(0, 1, 4, 1.4) },
            { id: `${P}#c-r-2`, number: '823/1#c-r-2', baseId: P, isCorridor: false, feature: block(0, 1.4, 4, 3) },
            { id: `${P}#c-r-3`, number: '823/1#c-r-3', baseId: P, isCorridor: false, feature: block(0, 0, 4, 1) }
        ];
        const after = [
            { baseId: P, isCorridor: true, feature: block(0, 1, 4, 1.2) },          // thinner corridor
            { baseId: P, isCorridor: false, feature: block(0, 1.2, 4, 3) },         // north grew
            { baseId: P, isCorridor: false, feature: block(0, 0, 4, 1) },           // south untouched
            { baseId: 'HR-339270-824', isCorridor: false, feature: block(5, 0, 6, 1) } // new ground
        ];
        const result = fe.matchPieces(before, after, ctx);
        expect(result.assignments).toEqual([0, 1, 2, null]);
        expect(result.unchangedAfterIndices).toEqual([2]);
        expect(result.reshapedAfterIndices).toEqual([0, 1]);
        expect(result.addedAfterIndices).toEqual([3]);
        expect(result.removedBeforeIndices).toEqual([]);
    });

    it('matches the corridor by role even when its geometry changed completely', () => {
        const before = [{ id: `${P}#c-r-1`, baseId: P, isCorridor: true, feature: block(0, 0, 1, 4) }];
        const after = [{ baseId: 'HR-339270-999', isCorridor: true, feature: block(3, 0, 4, 4) }];
        const result = fe.matchPieces(before, after, ctx);
        expect(result.assignments).toEqual([0]);
        expect(result.reshapedAfterIndices).toEqual([0]);
    });

    it('never matches across base parcels', () => {
        const before = [{ id: `${P}#c-r-2`, baseId: P, isCorridor: false, feature: block(0, 0, 1, 1) }];
        const after = [{ baseId: 'HR-339270-824', isCorridor: false, feature: block(0, 0, 1, 1) }];
        const result = fe.matchPieces(before, after, ctx);
        expect(result.assignments).toEqual([null]);
        expect(result.removedBeforeIndices).toEqual([0]);
    });

    it('drops identity when the road leaves a parcel and lets two prior slices merge into one id', () => {
        const before = [
            { id: `${P}#c-r-2`, baseId: P, isCorridor: false, feature: block(0, 0, 4, 1) },
            { id: `${P}#c-r-3`, baseId: P, isCorridor: false, feature: block(0, 1.4, 4, 3) }
        ];
        // The road left this parcel entirely: one whole-parcel piece now stands where two slices were.
        const after = [{ baseId: P, isCorridor: false, feature: block(0, 0, 4, 3) }];
        const result = fe.matchPieces(before, after, ctx);
        // Best-overlap prior wins (the bigger northern slice), the other id dies.
        expect(result.assignments).toEqual([1]);
        expect(result.removedBeforeIndices).toEqual([0]);
    });

    it('refuses a tier-2 match below the overlap share', () => {
        const before = [{ id: `${P}#c-r-2`, baseId: P, isCorridor: false, feature: block(0, 0, 1, 1) }];
        const after = [{ baseId: P, isCorridor: false, feature: block(0.8, 0, 4, 1) }]; // ~6% of the new piece
        const result = fe.matchPieces(before, after, ctx);
        expect(result.assignments).toEqual([null]);
    });
});

describe('applyCarriedIdentity', () => {
    it('writes id, number and parsed synthetic fields, once per id', () => {
        const used = new Set();
        const props = {};
        const carried = { parcelId: 'HR-339270-823/1#c-abc-7', parcelNumber: '823/1#c-abc-7' };
        expect(fe.applyCarriedIdentity(props, carried, used)).toBe(true);
        expect(props.parcelId).toBe('HR-339270-823/1#c-abc-7');
        expect(props.BROJ_CESTICE).toBe('823/1#c-abc-7');
        expect(props.syntheticToken).toBe('c-abc');
        expect(props.syntheticIndex).toBe(7);
        // A contiguity split cloned the stamp onto a second part — it must not get the same id.
        expect(fe.applyCarriedIdentity({}, carried, used)).toBe(false);
    });

    it('rejects empty identities', () => {
        expect(fe.applyCarriedIdentity({}, null, new Set())).toBe(false);
        expect(fe.applyCarriedIdentity({}, {}, new Set())).toBe(false);
    });
});

describe('footprintDelta', () => {
    it('reports no change for identical footprints', () => {
        const result = fe.footprintDelta(block(0, 0, 4, 1), block(0, 0, 4, 1), ctx);
        expect(result).not.toBeNull();
        expect(result.changed).toBe(false);
        expect(result.pieces).toEqual([]);
    });

    it('returns the freed strip when a road narrows', () => {
        const wide = block(0, 0, 4, 1);
        const narrow = block(0, 0, 4, 0.8);
        const result = fe.footprintDelta(wide, narrow, ctx);
        expect(result.changed).toBe(true);
        expect(result.pieces.length).toBe(1);
        const freed = turf.area(result.pieces[0]);
        const expected = turf.area(wide) - turf.area(narrow);
        expect(Math.abs(freed - expected)).toBeLessThan(1);
    });

    it('returns both sides of a move', () => {
        const result = fe.footprintDelta(block(0, 0, 4, 1), block(0, 0.5, 4, 1.5), ctx);
        expect(result.changed).toBe(true);
        expect(result.pieces.length).toBe(2);
    });

    it('returns null when geometry is missing', () => {
        expect(fe.footprintDelta(null, block(0, 0, 1, 1), ctx)).toBeNull();
    });
});

describe('proposalsOnChangedGround', () => {
    it('keeps proposals standing on the delta and leaves the rest alone', () => {
        const delta = [block(0, 0.8, 4, 1)]; // the freed strip
        const onStrip = { key: 'a', footprint: block(1, 0.7, 2, 1.2) };
        const elsewhere = { key: 'b', footprint: block(1, 2, 2, 3) };
        const touchingLine = { key: 'c', footprint: block(0, 1, 4, 2) }; // shares only the boundary
        const hits = fe.proposalsOnChangedGround(delta, [onStrip, elsewhere, touchingLine], ctx);
        expect(hits.map(entry => entry.key)).toEqual(['a']);
    });

    it('returns nothing for an empty delta', () => {
        expect(fe.proposalsOnChangedGround([], [{ key: 'a', footprint: block(0, 0, 1, 1) }], ctx)).toEqual([]);
    });
});

describe('retainedUnloadedParents', () => {
    it('keeps genuinely off-screen parents and drops touched, loaded and own-child ids', () => {
        const kept = fe.retainedUnloadedParents(
            ['HR-1', 'HR-2', 'HR-3#c-r-1', 'HR-4', 'HR-4'],
            {
                touchedIds: ['HR-1'],
                loadedIds: new Set(['HR-2']),
                ownChildIds: ['HR-3#c-r-1']
            }
        );
        expect(kept).toEqual(['HR-4']);
    });

    it('is the regression guard for the self-ghost bug: a recut must not re-declare its own dead children', () => {
        // The unapply removed the road's own children from the loaded-id map, so before the fix
        // they looked exactly like off-screen parents and were re-declared every edit.
        const kept = fe.retainedUnloadedParents(
            ['HR-339270-823/1#c-road-1', 'HR-339270-823/1#c-road-2'],
            { touchedIds: [], loadedIds: new Set(), ownChildIds: ['HR-339270-823/1#c-road-1', 'HR-339270-823/1#c-road-2'] }
        );
        expect(kept).toEqual([]);
    });
});

describe('baseIdsOfFeatures', () => {
    it('collects unique base ids from rootParcelId or the id itself, skipping placeholders', () => {
        const ids = fe.baseIdsOfFeatures([
            { properties: { rootParcelId: 'HR-1' } },
            { properties: { parcelId: 'HR-2#c-road-3' } },
            { properties: { rootParcelId: 'HR-1' } },
            { properties: { rootParcelId: 'parcel' } },
            null
        ]);
        expect(ids).toEqual(['HR-1', 'HR-2']);
    });
});

describe('overlappingBaseIds', () => {
    it('anchors a plot to every base parcel actually under it, in parent order', () => {
        // Parents side by side; the plot spans the boundary.
        const parents = [
            { baseId: 'HR-A', feature: block(0, 0, 2, 2) },
            { baseId: 'HR-B', feature: block(2, 0, 4, 2) },
            { baseId: 'HR-C', feature: block(4, 0, 6, 2) }
        ];
        const plot = block(1, 0, 3, 2);
        expect(fe.overlappingBaseIds(plot, parents, ctx)).toEqual(['HR-A', 'HR-B']);
    });

    it('ignores parents that only share a boundary line', () => {
        const parents = [
            { baseId: 'HR-A', feature: block(0, 0, 2, 2) },
            { baseId: 'HR-B', feature: block(2, 0, 4, 2) }
        ];
        const plot = block(0, 0, 2, 2); // exactly HR-A; touches HR-B only along the edge
        expect(fe.overlappingBaseIds(plot, parents, ctx)).toEqual(['HR-A']);
    });
});

describe('wholeParcelTakePlan', () => {
    const parcels = [
        { id: 'HR-A', feature: block(0, 0, 2, 2) },
        { id: 'HR-B', feature: block(2, 0, 4, 2) },
        { id: 'HR-C', feature: block(4, 0, 6, 2) }
    ];

    it('adopts the one parcel matching the footprint', () => {
        const plan = fe.wholeParcelTakePlan(block(0, 0, 2, 2), parcels, ctx);
        expect(plan.mode).toBe('adopt');
        expect(plan.parcelIds).toEqual(['HR-A']);
    });

    it('merge-takes a union of whole parcels', () => {
        const plan = fe.wholeParcelTakePlan(block(0, 0, 4, 2), parcels, ctx);
        expect(plan.mode).toBe('merge');
        expect(plan.parcelIds).toEqual(['HR-A', 'HR-B']);
    });

    it('refuses when the footprint takes only part of some parcel, naming it', () => {
        const plan = fe.wholeParcelTakePlan(block(0, 0, 3, 2), parcels, ctx);
        expect(plan.mode).toBe('refuse');
        expect(plan.reason).toBe('partial-parcels');
        expect(plan.parcelIds).toEqual(['HR-A']);          // whole
        expect(plan.partials.map(p => p.id)).toEqual(['HR-B']); // half-covered
        expect(plan.partials[0].coveredShare).toBeCloseTo(0.5, 1);
    });

    it('refuses when part of the footprint lies on no live parcel', () => {
        const plan = fe.wholeParcelTakePlan(block(0, 0, 2, 3), [parcels[0]], ctx);
        expect(plan.mode).toBe('refuse');
        expect(plan.reason).toBe('uncovered-ground');
    });

    it('ignores parcels that only share a boundary line', () => {
        const plan = fe.wholeParcelTakePlan(block(0, 0, 2, 2), parcels, ctx);
        expect(plan.parcelIds).toEqual(['HR-A']); // HR-B touches only along x=2
    });

    it('tolerates vertex noise on an exact fill (the Borovje case)', () => {
        const noisyFootprint = block(0.000005, 0, 2.000005, 2); // ~0.4 m shift
        const plan = fe.wholeParcelTakePlan(noisyFootprint, parcels, ctx);
        expect(plan.mode).toBe('adopt');
        expect(plan.parcelIds).toEqual(['HR-A']);
    });
});
