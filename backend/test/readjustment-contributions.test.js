// What each owner puts into a readjustment, in square metres.
//
// The rule, stated once: an owner's contribution from a parcel is the area of that parcel inside
// the take, multiplied by their recorded share of it — and the same owner appearing in several
// parcels is ONE contributor, aggregated. Simun's specification, 2026-08-10: "one owner could enter
// the LR with three full parcels and half of a fourth. The total area per owner matters, not the
// number of parcels. Parcels with multiple owners get divided by what the actual recorded share is
// (it carries over into this). Aggregate per owner, because they can pop up in different parcels."
//
// The failure this guards against is paying the wrong person. So the tests are about arithmetic and
// about what happens when the cadastre is not clean — never silently assigning land to nobody, and
// never silently assigning it to somebody.

import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');

let contrib;

beforeAll(() => {
    globalThis.turf = turf;
    contrib = require('../../frontend/js/proposals/readjustment-contributions.js');
});

const box = (w, s, e, n) => turf.polygon([[[w, s], [e, s], [e, n], [w, n], [w, s]]]);

// A parcel with owners. Coordinates are chosen so each parcel is ~1,000 m² at this latitude.
function parcel(id, geometry, owners) {
    return {
        type: 'Feature',
        properties: { parcelId: id, ownershipDetails: owners ? { owners } : undefined },
        geometry: geometry.geometry
    };
}

const owner = (name, percentageShare) => ({ name, ownerLabel: name, percentageShare });

const A = box(16.0000, 46.0000, 16.0004, 46.0003);
const B = box(16.0004, 46.0000, 16.0008, 46.0003);
const C = box(16.0008, 46.0000, 16.0012, 46.0003);

const areaOf = feature => turf.area(feature);

describe('one owner, whole parcels', () => {
    it('adds up the parcels they brought', () => {
        const parents = [parcel('P1', A, [owner('Ivan', 100)]), parcel('P2', B, [owner('Ivan', 100)])];
        const { contributions, totalM2 } = contrib.contributionsByOwner(parents, null);
        expect(contributions).toHaveLength(1);
        expect(contributions[0].name).toBe('Ivan');
        expect(contributions[0].areaM2).toBeCloseTo(areaOf(parcel('x', A)) + areaOf(parcel('x', B)), 0);
        expect(contributions[0].share).toBeCloseTo(1, 6);
        expect(totalM2).toBeCloseTo(contributions[0].areaM2, 0);
    });

    it('records which parcels it came from, without splitting the owner', () => {
        const parents = [parcel('P1', A, [owner('Ivan', 100)]), parcel('P2', B, [owner('Ivan', 100)])];
        const { contributions } = contrib.contributionsByOwner(parents, null);
        expect(contributions[0].parcels).toEqual(['P1', 'P2']);
    });
});

describe('the specified case: three whole parcels and half of a fourth', () => {
    const half = box(16.0012, 46.0000, 16.0016, 46.00015);   // the southern half of a fourth parcel
    const fourth = box(16.0012, 46.0000, 16.0016, 46.0003);

    it('counts only the part inside the take', () => {
        const parents = [
            parcel('P1', A, [owner('Ivan', 100)]),
            parcel('P2', B, [owner('Ivan', 100)]),
            parcel('P3', C, [owner('Ivan', 100)]),
            parcel('P4', fourth, [owner('Ivan', 100)])
        ];
        // The take swallows the first three whole and clips the fourth in half.
        const take = turf.union(turf.union(A, B), turf.union(C, half));
        const { contributions } = contrib.contributionsByOwner(parents, take);

        const whole = areaOf(parcel('x', A)) + areaOf(parcel('x', B)) + areaOf(parcel('x', C));
        const clipped = areaOf(parcel('x', fourth)) / 2;
        expect(contributions).toHaveLength(1);
        expect(contributions[0].areaM2).toBeCloseTo(whole + clipped, 0);
    });

    it('does not count the half left outside', () => {
        const parents = [parcel('P4', fourth, [owner('Ivan', 100)])];
        const { contributions } = contrib.contributionsByOwner(parents, half);
        expect(contributions[0].areaM2).toBeCloseTo(areaOf(parcel('x', fourth)) / 2, 0);
    });
});

describe('a parcel with several owners', () => {
    it('divides it by the recorded shares, not evenly', () => {
        const parents = [parcel('P1', A, [owner('Ivan', 50), owner('Ana', 25), owner('Marko', 25)])];
        const { contributions, totalM2 } = contrib.contributionsByOwner(parents, null);
        const area = areaOf(parcel('x', A));
        expect(totalM2).toBeCloseTo(area, 0);
        expect(contributions.map(c => c.name)).toEqual(['Ivan', 'Ana', 'Marko']);
        expect(contributions[0].areaM2).toBeCloseTo(area * 0.5, 0);
        expect(contributions[1].areaM2).toBeCloseTo(area * 0.25, 0);
        expect(contributions[2].areaM2).toBeCloseTo(area * 0.25, 0);
    });

    it('applies the share to the CLIPPED area, not to the whole parcel', () => {
        // Half the parcel is in the take; a half-owner therefore contributes a quarter of it.
        const southHalf = box(16.0000, 46.0000, 16.0004, 46.00015);
        const parents = [parcel('P1', A, [owner('Ivan', 50), owner('Ana', 50)])];
        const { contributions } = contrib.contributionsByOwner(parents, southHalf);
        expect(contributions[0].areaM2).toBeCloseTo(areaOf(parcel('x', A)) * 0.25, 0);
    });

    it('reads a share written as a fraction as well as a percentage', () => {
        const asPercent = contrib.contributionsByOwner([parcel('P1', A, [owner('Ivan', 25)])], null);
        const asFraction = contrib.contributionsByOwner([parcel('P1', A, [owner('Ivan', 0.25)])], null);
        expect(asFraction.contributions[0].areaM2).toBeCloseTo(asPercent.contributions[0].areaM2, 6);
    });

    it('reads "50%" written as text', () => {
        const { contributions } = contrib.contributionsByOwner([parcel('P1', A, [{ name: 'Ivan', percentageShare: '50%' }])], null);
        expect(contributions[0].areaM2).toBeCloseTo(areaOf(parcel('x', A)) * 0.5, 0);
    });
});

describe('one owner across several parcels is one contributor', () => {
    it('aggregates a whole parcel and a share of another', () => {
        const parents = [
            parcel('P1', A, [owner('Ivan', 100)]),
            parcel('P2', B, [owner('Ivan', 25), owner('Ana', 75)])
        ];
        const { contributions } = contrib.contributionsByOwner(parents, null);
        const a = areaOf(parcel('x', A));
        const b = areaOf(parcel('x', B));
        expect(contributions).toHaveLength(2);
        const ivan = contributions.find(c => c.name === 'Ivan');
        expect(ivan.areaM2).toBeCloseTo(a + b * 0.25, 0);
        expect(ivan.parcels).toEqual(['P1', 'P2']);
    });

    it('treats the same name written differently as the same person', () => {
        // Two half-payments to one person, not one payment each to two people who do not exist.
        const parents = [
            parcel('P1', A, [{ name: 'Ivan Horvat', percentageShare: 100 }]),
            parcel('P2', B, [{ name: '  IVAN   HORVAT ', percentageShare: 100 }])
        ];
        const { contributions } = contrib.contributionsByOwner(parents, null);
        expect(contributions).toHaveLength(1);
        expect(contributions[0].areaM2).toBeCloseTo(areaOf(parcel('x', A)) + areaOf(parcel('x', B)), 0);
    });

    it('shares sum to one across the pool', () => {
        const parents = [
            parcel('P1', A, [owner('Ivan', 100)]),
            parcel('P2', B, [owner('Ana', 50), owner('Marko', 50)])
        ];
        const { contributions } = contrib.contributionsByOwner(parents, null);
        expect(contributions.reduce((sum, c) => sum + c.share, 0)).toBeCloseTo(1, 6);
    });
});

describe('ground that touches the take but barely', () => {
    it('ignores a parcel the take only grazes', () => {
        const neighbour = box(16.0016, 46.0000, 16.0020, 46.0003);
        const parents = [parcel('P1', A, [owner('Ivan', 100)]), parcel('P9', neighbour, [owner('Ana', 100)])];
        const { contributions } = contrib.contributionsByOwner(parents, A);
        expect(contributions.map(c => c.name)).toEqual(['Ivan']);
    });
});

describe('plots may not cover the same ground', () => {
    // The take IS the union of the plots, so a gap or an excess against it cannot happen. An
    // overlap can, and it is the failure that corrupts the result quietly: the pool measures the
    // union correctly while two plots hand out the same square metre.
    const left = box(16.0000, 46.0000, 16.0004, 46.0003);
    const right = box(16.0004, 46.0000, 16.0008, 46.0003);
    const straddling = box(16.0002, 46.0000, 16.0006, 46.0003);

    it('accepts plots that merely meet along an edge', () => {
        expect(contrib.overlappingPlots([{ geometry: left.geometry }, { geometry: right.geometry }])).toEqual([]);
    });

    it('reports a genuine two-dimensional overlap, with which pair and how much', () => {
        const overlaps = contrib.overlappingPlots([{ geometry: left.geometry }, { geometry: straddling.geometry }]);
        expect(overlaps).toHaveLength(1);
        expect(overlaps[0]).toMatchObject({ a: 0, b: 1 });
        expect(overlaps[0].areaM2).toBeGreaterThan(100);
    });

    it('reports every offending pair, not just the first', () => {
        const overlaps = contrib.overlappingPlots([
            { geometry: left.geometry }, { geometry: straddling.geometry }, { geometry: right.geometry }
        ]);
        expect(overlaps.map(o => `${o.a}${o.b}`).sort()).toEqual(['01', '12']);
    });

    it('catches two plots with identical geometry', () => {
        expect(contrib.overlappingPlots([{ geometry: left.geometry }, { geometry: left.geometry }])).toHaveLength(1);
    });

    it('tolerates a hairline sliver along a shared edge', () => {
        // Manually cut plots overlap by float noise; that is not a plan error.
        const sliver = box(16.00039999, 46.0000, 16.0008, 46.0003);
        expect(contrib.overlappingPlots([{ geometry: left.geometry }, { geometry: sliver.geometry }])).toEqual([]);
    });

    it('does not object to a gap between plots — that land simply is not taken', () => {
        const far = box(16.0010, 46.0000, 16.0014, 46.0003);
        expect(contrib.overlappingPlots([{ geometry: left.geometry }, { geometry: far.geometry }])).toEqual([]);
    });

    it('accepts a bare geometry as well as a plot wrapper', () => {
        expect(contrib.overlappingPlots([left.geometry, straddling.geometry])).toHaveLength(1);
    });

    it('has nothing to say about zero or one plot', () => {
        expect(contrib.overlappingPlots([])).toEqual([]);
        expect(contrib.overlappingPlots([{ geometry: left.geometry }])).toEqual([]);
        expect(contrib.overlappingPlots(null)).toEqual([]);
    });

    it('skips an unusable plot rather than reporting a false overlap', () => {
        const broken = { geometry: { type: 'Polygon', coordinates: [] } };
        expect(contrib.overlappingPlots([broken, { geometry: left.geometry }])).toEqual([]);
    });
});

describe('a cadastre that is not clean is reported, never guessed', () => {
    it('pools land whose ownership is missing, and says so', () => {
        // Dropping it would make the totals lie; assigning it to the author would be theft.
        const parents = [parcel('P1', A, [owner('Ivan', 100)]), parcel('P2', B, null)];
        const { contributions, totalM2, unreadable } = contrib.contributionsByOwner(parents, null);
        expect(contributions).toHaveLength(1);
        expect(totalM2).toBeCloseTo(areaOf(parcel('x', A)) + areaOf(parcel('x', B)), 0);
        expect(unreadable).toHaveLength(1);
        expect(unreadable[0].parcelId).toBe('P2');
        expect(unreadable[0].areaM2).toBeCloseTo(areaOf(parcel('x', B)), 0);
    });

    it('reports shares that do not add up to the whole parcel', () => {
        const parents = [parcel('P1', A, [owner('Ivan', 50), owner('Ana', 25)])];
        const { contributions, unreadable } = contrib.contributionsByOwner(parents, null);
        expect(contributions).toHaveLength(2);
        expect(unreadable).toHaveLength(1);
        expect(unreadable[0].areaM2).toBeCloseTo(areaOf(parcel('x', A)) * 0.25, 0);
        expect(unreadable[0].reason).toMatch(/do not account/);
    });

    it('does not read an unusable share as zero or as everything', () => {
        expect(contrib.shareFractionOf({ percentageShare: null })).toBe(null);
        expect(contrib.shareFractionOf({ percentageShare: undefined })).toBe(null);
        expect(contrib.shareFractionOf({ percentageShare: 'half' })).toBe(null);
        expect(contrib.shareFractionOf({ percentageShare: -10 })).toBe(null);
        expect(contrib.shareFractionOf({ percentageShare: 140 })).toBe(null);
    });

    it('reads a sole owner recorded as 1 as the whole parcel', () => {
        expect(contrib.shareFractionOf({ percentageShare: 1 })).toBe(1);
    });

    it('survives a parcel with unusable geometry rather than voiding the pool', () => {
        const broken = { type: 'Feature', properties: { parcelId: 'BAD', ownershipDetails: { owners: [owner('X', 100)] } }, geometry: { type: 'Polygon', coordinates: [] } };
        const { contributions } = contrib.contributionsByOwner([broken, parcel('P1', A, [owner('Ivan', 100)])], null);
        expect(contributions.map(c => c.name)).toEqual(['Ivan']);
    });

    it('returns an empty pool for no parents rather than throwing', () => {
        expect(contrib.contributionsByOwner([], null)).toEqual({ contributions: [], totalM2: 0, unreadable: [] });
        expect(contrib.contributionsByOwner(null, null).contributions).toEqual([]);
    });
});
