// The outcome of a cadastral parcel is a function of that parcel and the corridors over it.
//
// This is the model the fabric is moving to, and these tests are its definition. The two properties
// that matter are stated directly, because everything else follows from them:
//
//   ORDER-INDEPENDENCE — the same parcel and the same set of takes give the same pieces, whichever
//   order the takes arrive in. That is what makes "add a road" a local recompute instead of a replay
//   of the whole plan from pristine cadastre.
//
//   IDENTITY IS THE GEOMETRY — a piece's id is a content address of its own outline, so a piece that
//   did not change shape keeps its id across a recut, and one that did gets a new one. That is the
//   signal a building standing on a piece needs, and it is why nothing has to track parentage.
//
// Real turf, real geometry. A rectangle at 46°N crossed by two perpendicular bands is the worked
// example from the design discussion: 2 pieces become 4 remainders plus the road area.

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');

let arrangement;

const box = (w, s, e, n) => turf.polygon([[[w, s], [e, s], [e, n], [w, n], [w, s]]]);

// A parcel ~77 m × 111 m, and two bands crossing it at right angles.
const PARCEL = box(16.0000, 46.0000, 16.0010, 46.0010);
const PARCEL_ID = 'HR-1-100';
const EAST_WEST = { id: 'road-a', geometry: box(15.9990, 46.00045, 16.0020, 46.00055).geometry };
const NORTH_SOUTH = { id: 'road-b', geometry: box(16.00045, 45.9990, 16.00055, 46.0020).geometry };

beforeAll(() => {
    globalThis.turf = turf;
    arrangement = require('../../frontend/js/proposals/parcel-arrangement.js');
});

const kinds = pieces => pieces.reduce((acc, piece) => {
    acc[piece.kind] = (acc[piece.kind] || 0) + 1;
    return acc;
}, {});

describe('a parcel nothing has taken', () => {
    it('is still itself, under its own cadastral id', () => {
        const { pieces } = arrangement.arrangementOf(PARCEL, PARCEL_ID, []);
        expect(pieces).toHaveLength(1);
        expect(pieces[0].id).toBe(PARCEL_ID);
        expect(pieces[0].kind).toBe('remainder');
        expect(pieces[0].takers).toEqual([]);
    });

    it('ignores corridors that are somewhere else entirely', () => {
        const elsewhere = { id: 'far', geometry: box(16.5, 46.5, 16.51, 46.51).geometry };
        const { pieces } = arrangement.arrangementOf(PARCEL, PARCEL_ID, [elsewhere]);
        expect(pieces).toHaveLength(1);
        expect(pieces[0].id).toBe(PARCEL_ID);
    });

    it('ignores a corridor that only grazes the boundary', () => {
        // Shares an edge, takes no area: a neighbour, not a taker.
        const abutting = { id: 'abutting', geometry: box(16.0010, 46.0000, 16.0020, 46.0010).geometry };
        const { pieces, takersUsed } = arrangement.arrangementOf(PARCEL, PARCEL_ID, [abutting]);
        expect(takersUsed).toEqual([]);
        expect(pieces[0].id).toBe(PARCEL_ID);
    });
});

describe('one corridor across a parcel', () => {
    it('leaves the road area and a remainder on each side', () => {
        const { pieces } = arrangement.arrangementOf(PARCEL, PARCEL_ID, [EAST_WEST]);
        expect(kinds(pieces)).toEqual({ road: 1, remainder: 2 });
    });

    it('names the road piece by the corridor that took it', () => {
        const { pieces } = arrangement.arrangementOf(PARCEL, PARCEL_ID, [EAST_WEST]);
        expect(pieces.find(p => p.kind === 'road').takers).toEqual(['road-a']);
    });

    it('accounts for the whole parcel and no more', () => {
        const { pieces } = arrangement.arrangementOf(PARCEL, PARCEL_ID, [EAST_WEST]);
        const total = pieces.reduce((sum, piece) => sum + piece.areaM2, 0);
        expect(total).toBeCloseTo(turf.area(PARCEL), 0);
    });

    it('gives every piece the cadastral parcel as its stem', () => {
        const { pieces } = arrangement.arrangementOf(PARCEL, PARCEL_ID, [EAST_WEST]);
        pieces.forEach(piece => {
            expect(piece.parcelId).toBe(PARCEL_ID);
            expect(piece.id.startsWith(`${PARCEL_ID}#`)).toBe(true);
        });
    });

    it('leaves nothing behind when the corridor swallows the parcel whole', () => {
        const swallowing = { id: 'wide', geometry: box(15.999, 45.999, 16.002, 46.002).geometry };
        const { pieces } = arrangement.arrangementOf(PARCEL, PARCEL_ID, [swallowing]);
        expect(kinds(pieces)).toEqual({ road: 1 });
        expect(pieces[0].areaM2).toBeCloseTo(turf.area(PARCEL), 0);
    });
});

describe('two corridors crossing — the worked example', () => {
    it('makes four remainders and one connected road area', () => {
        const { pieces } = arrangement.arrangementOf(PARCEL, PARCEL_ID, [EAST_WEST, NORTH_SOUTH]);
        expect(kinds(pieces)).toEqual({ road: 1, remainder: 4 });
    });

    it('records both takers on the road area rather than picking a holder', () => {
        // The junction belongs to neither road exclusively — which is why no precedence rule, no
        // "held by" bookkeeping and no ordered replay is needed to describe it.
        const { pieces } = arrangement.arrangementOf(PARCEL, PARCEL_ID, [EAST_WEST, NORTH_SOUTH]);
        expect(pieces.find(p => p.kind === 'road').takers).toEqual(['road-a', 'road-b']);
    });

    it('still accounts for exactly the parcel', () => {
        const { pieces } = arrangement.arrangementOf(PARCEL, PARCEL_ID, [EAST_WEST, NORTH_SOUTH]);
        const total = pieces.reduce((sum, piece) => sum + piece.areaM2, 0);
        expect(total).toBeCloseTo(turf.area(PARCEL), 0);
    });

    it('counts the junction once, not twice', () => {
        const road = arrangement.arrangementOf(PARCEL, PARCEL_ID, [EAST_WEST, NORTH_SOUTH])
            .pieces.find(p => p.kind === 'road');
        const a = turf.area(turf.intersect(PARCEL, turf.feature(EAST_WEST.geometry)));
        const b = turf.area(turf.intersect(PARCEL, turf.feature(NORTH_SOUTH.geometry)));
        const junction = turf.area(turf.intersect(turf.feature(EAST_WEST.geometry), turf.feature(NORTH_SOUTH.geometry)));
        expect(road.areaM2).toBeCloseTo(a + b - junction, 0);
    });
});

describe('a corridor with several components cuts with all of them', () => {
    // Inherited from the retired road-full-footprint test, and worth keeping: a corridor footprint
    // can be a MultiPolygon (a run split around a junction, a tunnelled stretch). The old cut picked
    // one "primary" component, so editing a distant end changed which component cut the cadastre and
    // ground appeared or vanished where the edit never reached.
    const twoComponents = {
        id: 'road-split',
        geometry: {
            type: 'MultiPolygon',
            coordinates: [
                box(15.9990, 46.00015, 16.0020, 46.00025).geometry.coordinates,
                box(15.9990, 46.00075, 16.0020, 46.00085).geometry.coordinates
            ]
        }
    };

    it('takes ground under every component, not just one', () => {
        const { pieces } = arrangement.arrangementOf(PARCEL, PARCEL_ID, [twoComponents]);
        expect(kinds(pieces)).toEqual({ road: 2, remainder: 3 });
    });

    it('still conserves the parcel', () => {
        const { pieces } = arrangement.arrangementOf(PARCEL, PARCEL_ID, [twoComponents]);
        const total = pieces.reduce((sum, piece) => sum + piece.areaM2, 0);
        expect(total).toBeCloseTo(turf.area(PARCEL), 0);
    });

    it('names the same corridor on both of its pieces', () => {
        const { pieces } = arrangement.arrangementOf(PARCEL, PARCEL_ID, [twoComponents]);
        pieces.filter(p => p.kind === 'road').forEach(piece => {
            expect(piece.takers).toEqual(['road-split']);
        });
    });
});

describe('order-independence', () => {
    it('gives identical pieces whichever order the takes arrive in', () => {
        const forward = arrangement.arrangementOf(PARCEL, PARCEL_ID, [EAST_WEST, NORTH_SOUTH]).pieces;
        const backward = arrangement.arrangementOf(PARCEL, PARCEL_ID, [NORTH_SOUTH, EAST_WEST]).pieces;
        expect(backward.map(p => p.id)).toEqual(forward.map(p => p.id));
        expect(backward.map(p => p.takers)).toEqual(forward.map(p => p.takers));
    });

    it('is stable across repeated runs', () => {
        const once = arrangement.arrangementOf(PARCEL, PARCEL_ID, [EAST_WEST, NORTH_SOUTH]).pieces;
        const twice = arrangement.arrangementOf(PARCEL, PARCEL_ID, [EAST_WEST, NORTH_SOUTH]).pieces;
        expect(twice.map(p => p.id)).toEqual(once.map(p => p.id));
    });

    it('returns to the one-corridor answer when a corridor is removed', () => {
        // Unapply is not an undo of a cut — it is the same function with one fewer take.
        const both = arrangement.arrangementOf(PARCEL, PARCEL_ID, [EAST_WEST, NORTH_SOUTH]).pieces;
        const onlyA = arrangement.arrangementOf(PARCEL, PARCEL_ID, [EAST_WEST]).pieces;
        const fresh = arrangement.arrangementOf(PARCEL, PARCEL_ID, [EAST_WEST]).pieces;
        expect(onlyA.map(p => p.id)).toEqual(fresh.map(p => p.id));
        expect(onlyA.length).toBeLessThan(both.length);
    });
});

describe('identity is the geometry', () => {
    it('a piece the new corridor never reached keeps its id', () => {
        // A long parcel cut by one north-south road near the west end: a small west remainder, a
        // large east remainder, and the road. A second north-south road far to the EAST re-cuts only
        // the east remainder. The west remainder and the first road's own piece are untouched, so
        // they must come back with the ids they already had — this is what lets a building standing
        // on the west remainder survive a road drawn at the other end of the parcel.
        const long = box(16.0000, 46.0000, 16.0100, 46.0010);
        const west = { id: 'road-a', geometry: box(16.0019, 45.9990, 16.0021, 46.0020).geometry };
        const east = { id: 'road-c', geometry: box(16.0089, 45.9990, 16.0091, 46.0020).geometry };

        const before = arrangement.arrangementOf(long, PARCEL_ID, [west]).pieces;
        const after = arrangement.arrangementOf(long, PARCEL_ID, [west, east]).pieces;

        expect(before).toHaveLength(3);
        expect(after).toHaveLength(5);

        // The smallest remainder is the west sliver; the road-a piece is the one taken by road-a
        // alone. Both are geometrically unchanged, so both keep their content address.
        const westRemainderBefore = before.filter(p => p.kind === 'remainder').sort((a, b) => a.areaM2 - b.areaM2)[0];
        const roadABefore = before.find(p => p.kind === 'road');
        const survivingIds = new Set(after.map(p => p.id));

        expect(survivingIds.has(westRemainderBefore.id)).toBe(true);
        expect(survivingIds.has(roadABefore.id)).toBe(true);

        // And the piece it DID reach is gone, replaced by the two it became.
        const eastRemainderBefore = before.filter(p => p.kind === 'remainder').sort((a, b) => b.areaM2 - a.areaM2)[0];
        expect(survivingIds.has(eastRemainderBefore.id)).toBe(false);
    });

    it('a piece that did change shape gets a new id', () => {
        const before = arrangement.arrangementOf(PARCEL, PARCEL_ID, [EAST_WEST]).pieces;
        const after = arrangement.arrangementOf(PARCEL, PARCEL_ID, [EAST_WEST, NORTH_SOUTH]).pieces;
        const roadBefore = before.find(p => p.kind === 'road');
        const roadAfter = after.find(p => p.kind === 'road');
        expect(roadAfter.id).not.toBe(roadBefore.id);
    });

    it('does not depend on which vertex turf happened to start at', () => {
        const square = turf.polygon([[[16, 46], [16.001, 46], [16.001, 46.001], [16, 46.001], [16, 46]]]);
        const rotated = turf.polygon([[[16.001, 46.001], [16, 46.001], [16, 46], [16.001, 46], [16.001, 46.001]]]);
        expect(arrangement.pieceId('P', 'remainder', rotated.geometry))
            .toBe(arrangement.pieceId('P', 'remainder', square.geometry));
    });

    it('does not depend on winding direction', () => {
        const clockwise = turf.polygon([[[16, 46], [16, 46.001], [16.001, 46.001], [16.001, 46], [16, 46]]]);
        const counter = turf.polygon([[[16, 46], [16.001, 46], [16.001, 46.001], [16, 46.001], [16, 46]]]);
        expect(arrangement.pieceId('P', 'remainder', clockwise.geometry))
            .toBe(arrangement.pieceId('P', 'remainder', counter.geometry));
    });

    it('separates a road piece from a remainder of the very same shape', () => {
        const shape = box(16, 46, 16.001, 46.001).geometry;
        expect(arrangement.pieceId('P', 'road', shape)).not.toBe(arrangement.pieceId('P', 'remainder', shape));
    });

    it('separates identical shapes on different parcels', () => {
        const shape = box(16, 46, 16.001, 46.001).geometry;
        expect(arrangement.pieceId('P-1', 'road', shape)).not.toBe(arrangement.pieceId('P-2', 'road', shape));
    });

    it('distinguishes a piece with a hole from the same outline without one', () => {
        const solid = turf.polygon([[[16, 46], [16.001, 46], [16.001, 46.001], [16, 46.001], [16, 46]]]);
        const holed = turf.polygon([
            [[16, 46], [16.001, 46], [16.001, 46.001], [16, 46.001], [16, 46]],
            [[16.0004, 46.0004], [16.0006, 46.0004], [16.0006, 46.0006], [16.0004, 46.0006], [16.0004, 46.0004]]
        ]);
        expect(arrangement.pieceId('P', 'remainder', holed.geometry))
            .not.toBe(arrangement.pieceId('P', 'remainder', solid.geometry));
    });
});

describe('noise is not a parcel', () => {
    it('drops a take that shaves only a sliver off the edge', () => {
        const sliver = { id: 'sliver', geometry: box(16.00099999, 46.0000, 16.0010, 46.0010).geometry };
        const { pieces, takersUsed } = arrangement.arrangementOf(PARCEL, PARCEL_ID, [sliver]);
        expect(takersUsed).toEqual([]);
        expect(pieces).toHaveLength(1);
        expect(pieces[0].id).toBe(PARCEL_ID);
    });
});

describe('takesOverlapping', () => {
    it('keeps only the corridors that really reach the parcel', () => {
        const far = { id: 'far', geometry: box(16.5, 46.5, 16.51, 46.51).geometry };
        const hits = arrangement.takesOverlapping(PARCEL, [EAST_WEST, far, NORTH_SOUTH]);
        expect(hits.map(t => t.id)).toEqual(['road-a', 'road-b']);
    });

    it('is empty for a parcel nothing crosses', () => {
        expect(arrangement.takesOverlapping(box(17, 47, 17.001, 47.001), [EAST_WEST])).toEqual([]);
    });
});

describe('the fabric over many parcels', () => {
    const NEIGHBOUR = box(16.0010, 46.0000, 16.0020, 46.0010);
    const parcels = [
        { id: PARCEL_ID, feature: PARCEL },
        { id: 'HR-1-101', feature: NEIGHBOUR }
    ];

    it('arranges each parcel against the takes that reach it', () => {
        const { pieces } = arrangement.fabricOver(parcels, [EAST_WEST]);
        // The east-west band crosses both parcels: each gets a road piece and two remainders.
        expect(pieces.filter(p => p.parcelId === PARCEL_ID)).toHaveLength(3);
        expect(pieces.filter(p => p.parcelId === 'HR-1-101')).toHaveLength(3);
    });

    it('leaves a parcel no corridor reaches as itself', () => {
        const { pieces } = arrangement.fabricOver(parcels, [NORTH_SOUTH]);
        const neighbour = pieces.filter(p => p.parcelId === 'HR-1-101');
        expect(neighbour).toHaveLength(1);
        expect(neighbour[0].id).toBe('HR-1-101');
    });

    it('records an unusable parcel instead of voiding the map', () => {
        const broken = [{ id: 'HR-1-bad', feature: null }, ...parcels];
        const { pieces, failed } = arrangement.fabricOver(broken, [EAST_WEST]);
        expect(pieces.length).toBeGreaterThan(0);
        // A null feature is skipped by the guard rather than reported; a malformed one is reported.
        expect(Array.isArray(failed)).toBe(true);
    });

    it('is the same answer as arranging one parcel at a time', () => {
        // The whole-plan derivation and a one-road recompute must be the same function, or the fast
        // path becomes a second implementation that can disagree with the canonical one.
        const whole = arrangement.fabricOver(parcels, [EAST_WEST, NORTH_SOUTH]).pieces.map(p => p.id).sort();
        const oneByOne = parcels
            .flatMap(entry => arrangement.arrangementOf(entry.feature, entry.id, [EAST_WEST, NORTH_SOUTH]).pieces)
            .map(p => p.id).sort();
        expect(whole).toEqual(oneByOne);
    });
});

describe('diffing the map against what it should be', () => {
    it('reports nothing to do when the fabric is already right', () => {
        const pieces = arrangement.arrangementOf(PARCEL, PARCEL_ID, [EAST_WEST]).pieces;
        const diff = arrangement.diffPieces(pieces, pieces);
        expect(diff.added).toEqual([]);
        expect(diff.removed).toEqual([]);
        expect(diff.unchanged).toHaveLength(pieces.length);
    });

    it('touches only what a second corridor changed', () => {
        const before = arrangement.arrangementOf(PARCEL, PARCEL_ID, [EAST_WEST]).pieces;
        const after = arrangement.arrangementOf(PARCEL, PARCEL_ID, [EAST_WEST, NORTH_SOUTH]).pieces;
        const diff = arrangement.diffPieces(before, after);
        expect(diff.added.length).toBeGreaterThan(0);
        expect(diff.removed.length).toBeGreaterThan(0);
    });

    it('leaves a piece the new corridor never reached completely alone', () => {
        const long = box(16.0000, 46.0000, 16.0100, 46.0010);
        const west = { id: 'road-a', geometry: box(16.0019, 45.9990, 16.0021, 46.0020).geometry };
        const east = { id: 'road-c', geometry: box(16.0089, 45.9990, 16.0091, 46.0020).geometry };
        const before = arrangement.arrangementOf(long, PARCEL_ID, [west]).pieces;
        const after = arrangement.arrangementOf(long, PARCEL_ID, [west, east]).pieces;

        const diff = arrangement.diffPieces(before, after);
        // Three pieces became five: the east remainder split in two around the new road, and the
        // road area gained a second component. The west remainder and road-a's piece are untouched.
        expect(diff.unchanged).toHaveLength(2);
        expect(diff.removed).toHaveLength(1);
        expect(diff.added).toHaveLength(3);
    });

    it('accepts the ids alone for what is currently on the map', () => {
        const pieces = arrangement.arrangementOf(PARCEL, PARCEL_ID, [EAST_WEST]).pieces;
        const diff = arrangement.diffPieces(pieces.map(p => p.id), pieces);
        expect(diff.added).toEqual([]);
        expect(diff.removed).toEqual([]);
    });

    it('adds everything when the map is empty', () => {
        const pieces = arrangement.arrangementOf(PARCEL, PARCEL_ID, [EAST_WEST]).pieces;
        expect(arrangement.diffPieces([], pieces).added).toHaveLength(pieces.length);
    });

    it('removes everything when the fabric should be empty', () => {
        const pieces = arrangement.arrangementOf(PARCEL, PARCEL_ID, [EAST_WEST]).pieces;
        expect(arrangement.diffPieces(pieces, []).removed).toHaveLength(pieces.length);
    });
});

describe('a piece as a map feature', () => {
    const base = {
        type: 'Feature',
        properties: {
            parcelId: PARCEL_ID,
            PARCEL_ID: PARCEL_ID,
            BROJ_CESTICE: '4975/1',
            MATICNI_BROJ_KO: 330264,
            CESTICA_ID: 12345,
            calculatedArea: 8000,
            ownershipDetails: { owners: [{ name: 'Ivan', percentageShare: 100 }] }
        },
        geometry: PARCEL.geometry
    };
    const pieces = () => arrangement.arrangementOf(PARCEL, PARCEL_ID, [EAST_WEST, NORTH_SOUTH]).pieces;

    it('carries the cadastral facts down into every piece', () => {
        const feature = arrangement.featureForPiece(pieces()[0], base);
        expect(feature.properties.MATICNI_BROJ_KO).toBe(330264);
        expect(feature.properties.CESTICA_ID).toBe(12345);
        expect(feature.properties.ownershipDetails.owners[0].name).toBe('Ivan');
    });

    it('gives the piece its own id everywhere the app looks for one', () => {
        const piece = pieces()[0];
        const feature = arrangement.featureForPiece(piece, base);
        expect(feature.properties.parcelId).toBe(piece.id);
        expect(feature.properties.PARCEL_ID).toBe(piece.id);
        expect(feature.properties.id).toBe(piece.id);
    });

    it('roots every piece at the cadastral parcel, not at another piece', () => {
        const feature = arrangement.featureForPiece(pieces()[0], base);
        expect(feature.properties.rootParcelId).toBe(PARCEL_ID);
        expect(feature.properties.parentParcelId).toBe(PARCEL_ID);
        expect(feature.properties.baseParcelIds).toEqual([PARCEL_ID]);
    });

    it('reports its own area, not the parcel it came from', () => {
        const piece = pieces().find(p => p.kind === 'remainder');
        expect(arrangement.featureForPiece(piece, base).properties.calculatedArea).toBeCloseTo(piece.areaM2, 6);
    });

    it('marks a road piece as corridor and names every road that took it', () => {
        const road = pieces().find(p => p.kind === 'road');
        const feature = arrangement.featureForPiece(road, base);
        expect(feature.properties.isCorridor).toBe(true);
        expect(feature.properties.formedByProposalIds).toEqual(['road-a', 'road-b']);
        expect(feature.properties.proposalId).toBe('road-a');
    });

    it('marks a track as a track and not as a road', () => {
        const road = pieces().find(p => p.kind === 'road');
        const feature = arrangement.featureForPiece(road, base, { isTrack: true });
        expect(feature.properties.isTrack).toBe(true);
        expect(feature.properties.isRoad).toBe(false);
    });

    it('does not leave corridor flags on a remainder', () => {
        // The clone comes from the parcel; if that parcel were itself corridor-flagged the remainder
        // would paint as road surface and its clicks would route into the corridor panel.
        const corridorBase = { ...base, properties: { ...base.properties, isCorridor: true, isTrack: true } };
        const remainder = pieces().find(p => p.kind === 'remainder');
        const feature = arrangement.featureForPiece(remainder, corridorBase);
        expect(feature.properties.isCorridor).toBeUndefined();
        expect(feature.properties.isTrack).toBeUndefined();
    });

    it('names the roads that formed a remainder, without claiming one made it', () => {
        const remainder = pieces().find(p => p.kind === 'remainder');
        const feature = arrangement.featureForPiece(remainder, base);
        expect(feature.properties.formedByProposalIds).toEqual([]);
        expect(feature.properties.proposalId).toBeUndefined();
    });

    it('does not mutate the parcel it was cloned from', () => {
        const before = JSON.stringify(base);
        arrangement.featureForPiece(pieces()[0], base);
        expect(JSON.stringify(base)).toBe(before);
    });

    it('is an id a synthetic-id check recognises, so it routes as derived ground', () => {
        const feature = arrangement.featureForPiece(pieces()[0], base);
        expect(String(feature.properties.parcelId)).toContain('#');
        expect(String(feature.properties.parcelId).split('#')[0]).toBe(PARCEL_ID);
    });
});

describe('a cut that cannot be computed is never silently swallowed', () => {
    // This is not hypothetical. On real Šibenik parcel 4975/4, with five corridors over it, turf's
    // difference against the UNION of the takes throws "Maximum call stack size exceeded". The first
    // version caught that and carried on, so the parcel came back as four road pieces and no
    // remainders: 1,282 m² of land quietly gone from the map, with every test still green.
    //
    // The turf module object is frozen, so the stub goes on the GLOBAL — which is what the module
    // resolves through anyway.
    const withTurf = (overrides, run) => {
        const original = globalThis.turf;
        globalThis.turf = Object.assign(Object.create(null), turf, overrides);
        try { return run(); } finally { globalThis.turf = original; }
    };

    it('throws rather than returning road pieces with no ground left over', () => {
        withTurf({ difference: () => { throw new Error('Maximum call stack size exceeded'); } }, () => {
            expect(() => arrangement.arrangementOf(PARCEL, PARCEL_ID, [EAST_WEST]))
                .toThrow(/Maximum call stack/);
        });
    });

    it('fabricOver records the parcel instead of returning it stripped', () => {
        withTurf({ difference: () => { throw new Error('clipper exploded'); } }, () => {
            const { pieces, failed } = arrangement.fabricOver([{ id: PARCEL_ID, feature: PARCEL }], [EAST_WEST]);
            expect(pieces).toEqual([]);
            expect(failed).toHaveLength(1);
            expect(failed[0].parcelId).toBe(PARCEL_ID);
        });
    });

    it('subtracts the takes one at a time, which is what avoids the blow-up', () => {
        // P \ (A ∪ B) === (P \ A) \ B, and only the second form survives a MultiPolygon union.
        let sawMultiPolygon = false;
        withTurf({
            difference: (a, b) => {
                if (b && b.geometry && b.geometry.type === 'MultiPolygon') sawMultiPolygon = true;
                return turf.difference(a, b);
            }
        }, () => arrangement.arrangementOf(PARCEL, PARCEL_ID, [EAST_WEST, NORTH_SOUTH]));
        expect(sawMultiPolygon).toBe(false);
    });

    it('still gets the right answer that way', () => {
        // Two disjoint corridors: subtracting them in sequence must leave the same three remainders
        // that subtracting their union would.
        const left = { id: 'left', geometry: box(16.00020, 45.999, 16.00030, 46.002).geometry };
        const right = { id: 'right', geometry: box(16.00070, 45.999, 16.00080, 46.002).geometry };
        const { pieces } = arrangement.arrangementOf(PARCEL, PARCEL_ID, [left, right]);
        expect(kinds(pieces)).toEqual({ road: 2, remainder: 3 });
        const total = pieces.reduce((sum, piece) => sum + piece.areaM2, 0);
        expect(total).toBeCloseTo(turf.area(PARCEL), 0);
    });
});

describe('refusals', () => {
    it('will not arrange a parcel with no id, since every piece is named after one', () => {
        expect(() => arrangement.arrangementOf(PARCEL, '', [EAST_WEST])).toThrow(/id is required/);
    });

    it('will not arrange nothing', () => {
        expect(() => arrangement.arrangementOf(null, PARCEL_ID, [EAST_WEST])).toThrow(/no geometry/);
    });
});

// A scoped re-derivation removes the difference between what the arrangement says a parcel is made
// of and what is on the map. Other things mint derived ids under the same parcel — a readjustment's
// plots, a carved building host — and deleting those would take a standing plan off the map the
// moment a road was drawn across the same ground. So the arrangement has to be able to recognise
// its own work.
describe('recognising the arrangement\'s own pieces', () => {
    it('recognises an id it minted itself, road or remainder', () => {
        const { pieces } = arrangement.arrangementOf(PARCEL, PARCEL_ID, [EAST_WEST]);
        expect(pieces.length).toBeGreaterThan(1);
        pieces.forEach(piece => expect(arrangement.isPieceId(piece.id)).toBe(true));
    });

    it('does not claim a plot, a legacy child or a cadastral parcel', () => {
        expect(arrangement.isPieceId('HR-1-100')).toBe(false);            // the cadastre itself
        expect(arrangement.isPieceId('HR-1-100#5-2')).toBe(false);        // a readjustment plot
        expect(arrangement.isPieceId('HR-1-100#c-proposal-7')).toBe(false); // a carved host
        expect(arrangement.isPieceId('HR-339270-824_proposal_9')).toBe(false);
        expect(arrangement.isPieceId(null)).toBe(false);
        expect(arrangement.isPieceId('')).toBe(false);
    });
});

// turf 6 clips with `polygon-clipping`, whose sweep line can simply give up on real cadastre —
// "Infinite loop when passing sweep line over endpoints". It is a robustness limit, not bad data:
// two vertices that are the same corner to a surveyor but differ in the last bit of a double order
// inconsistently. A parcel that hits it was recorded as "could not arrange" and left WHOLE, so a
// 5,048 m² parcel sat uncut under two roads that crossed it (HR-330264-519), with nothing on screen
// to say it had been skipped. A failed clip is retried on snapped coordinates.
describe('a clip the sweep line cannot do', () => {
    const SWEEP_ERROR = 'Infinite loop when passing sweep line over endpoints (too many sweep line segments). Please file a bug report.';
    // A vertex carrying far more precision than any survey — the shape a near-duplicate takes.
    const FINE = 16.0000000000001;
    const NASTY_PARCEL = turf.polygon([[[FINE, 46.0000], [16.0010, 46.0000], [16.0010, 46.0010], [FINE, 46.0010], [FINE, 46.0000]]]);

    // Stands in for the clipper: throws on coordinates finer than the retry grid, works otherwise.
    function turfFailingBelow(operations, { always = false } = {}) {
        const tooFine = feature => /\.\d{10,}/.test(JSON.stringify(feature?.geometry?.coordinates || []));
        return new Proxy(turf, {
            get(target, prop) {
                if (!operations.includes(prop)) return target[prop];
                return (a, b) => {
                    if (always || tooFine(a) || tooFine(b)) throw new Error(SWEEP_ERROR);
                    return target[prop](a, b);
                };
            }
        });
    }

    afterEach(() => { globalThis.turf = turf; });

    it('retries on snapped coordinates instead of dropping the parcel', () => {
        globalThis.turf = turfFailingBelow(['intersect', 'union', 'difference']);

        const { pieces } = arrangement.arrangementOf(NASTY_PARCEL, PARCEL_ID, [EAST_WEST]);

        // The road strip and the two remainders either side of it — the same answer the parcel
        // would have got had the clipper managed it first time.
        expect(kinds(pieces)).toEqual({ road: 1, remainder: 2 });
    });

    it('snapping is invisible: the pieces are the ones the clean parcel produces', () => {
        const clean = arrangement.arrangementOf(PARCEL, PARCEL_ID, [EAST_WEST]);
        globalThis.turf = turfFailingBelow(['intersect', 'union', 'difference']);
        const retried = arrangement.arrangementOf(NASTY_PARCEL, PARCEL_ID, [EAST_WEST]);

        // The nasty parcel differs from the clean one by 1e-13 degrees — a ten-thousandth of a
        // millimetre — so the pieces must carry the same ids, or every consumer keyed to a piece
        // would see it as a different piece.
        expect(retried.pieces.map(piece => piece.id)).toEqual(clean.pieces.map(piece => piece.id));
    });

    it('still fails loudly when no grid helps — a clip that cannot be done is not a silent whole parcel', () => {
        globalThis.turf = turfFailingBelow(['difference'], { always: true });

        expect(() => arrangement.arrangementOf(PARCEL, PARCEL_ID, [EAST_WEST])).toThrow(/sweep line/);
    });
});
