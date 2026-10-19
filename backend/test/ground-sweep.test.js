// Moving a road's nodes removed four blocks, then twelve, none of which the road touched.
//
// The sweep that takes proposals off divided ground asked its question of the design's UNION: does
// the whole thing still fit inside one piece of one parcel? A block is one building per parcel, so
// once it spans two parcels the union cannot fit inside any single piece — the answer was always
// "no", and the block fell whenever the road divided ANY parcel it happened to build on, with the
// cut fifty metres from every building.
//
// The question belongs per building. Real turf, real geometry: these are the shapes, not a story
// about them.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sweep = require('../../frontend/js/proposals/ground-sweep.js');
const turf = require('@turf/turf');

const ops = {
    intersectionArea: (a, b) => {
        try { const hit = turf.intersect(a, b); return hit ? (turf.area(hit) || 0) : 0; } catch (_) { return 0; }
    },
    area: shape => { try { return turf.area(shape) || 0; } catch (_) { return 0; } }
};

/** A rectangle in degrees, near Šibenik so the metre areas are realistic. */
function rect(x0, y0, x1, y1) {
    return turf.polygon([[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]);
}
const D = 0.0001;                  // ~8 m of longitude here; areas below are ~tens of m²
const at = n => 15.9 + n * D;
const lat = n => 43.73 + n * D;

// Three parcels side by side. The road divides the THIRD one only, into two pieces.
const parcelOne = rect(at(0), lat(0), at(4), lat(4));
const parcelTwo = rect(at(4), lat(0), at(8), lat(4));
const pieceThreeLower = rect(at(8), lat(0), at(12), lat(2));
const pieceThreeUpper = rect(at(8), lat(2.5), at(12), lat(4));

describe('designParts — what a design is actually made of', () => {
    const footprint = rect(at(0), lat(0), at(1), lat(1));

    it('a building design is its buildings, one part each', () => {
        const record = { geometry: { buildings: [parcelOne, parcelTwo] } };
        expect(sweep.designParts(record, true, footprint)).toHaveLength(2);
    });

    it('accepts bare geometries as well as features', () => {
        const record = { geometry: { buildings: [parcelOne.geometry, parcelTwo.geometry] } };
        const parts = sweep.designParts(record, true, footprint);
        expect(parts).toHaveLength(2);
        expect(parts[0].type).toBe('Feature');
    });

    it('reads buildingProposal.buildings when geometry has none', () => {
        const record = { buildingProposal: { buildings: [parcelOne] } };
        expect(sweep.designParts(record, true, footprint)).toHaveLength(1);
    });

    it('falls back to the footprint, and non-building designs are one part', () => {
        expect(sweep.designParts({}, true, footprint)).toEqual([footprint]);
        expect(sweep.designParts({ geometry: { buildings: [parcelOne] } }, false, footprint)).toEqual([footprint]);
        expect(sweep.designParts({}, false, null)).toEqual([]);
    });
});

describe('what the cut actually severed', () => {
    const pieces = [pieceThreeLower, pieceThreeUpper];

    it('a design nowhere near the divided parcel is not even standing here', () => {
        const away = [rect(at(0.5), lat(0.5), at(1.5), lat(1.5))];
        const verdict = sweep.inspectDesignAgainstPieces(away, pieces, ops);
        expect(verdict.standsHere).toBe(false);
        expect(verdict.severed).toBe(false);
    });

    it('THE REGRESSION: a block that builds on the divided parcel, clear of the cut, survives', () => {
        // Three buildings, one per parcel. The third sits wholly inside the lower piece — the cut
        // missed it. Judged as a union these three can never fit in one piece, and the block fell.
        const buildings = [
            rect(at(1), lat(1), at(3), lat(3)),          // parcel one
            rect(at(5), lat(1), at(7), lat(3)),          // parcel two
            rect(at(8.5), lat(0.5), at(11.5), lat(1.5))  // parcel three, inside the LOWER piece
        ];
        const verdict = sweep.inspectDesignAgainstPieces(buildings, pieces, ops);
        expect(verdict.standsHere).toBe(true);
        expect(verdict.severed).toBe(false);
        expect(verdict.severedParts).toBe(0);
    });

    it('a building the cut runs through is severed, and says which', () => {
        const buildings = [
            rect(at(1), lat(1), at(3), lat(3)),
            rect(at(8.5), lat(1), at(11.5), lat(3))      // straddles the gap: in BOTH pieces
        ];
        const verdict = sweep.inspectDesignAgainstPieces(buildings, pieces, ops);
        expect(verdict.standsHere).toBe(true);
        expect(verdict.severed).toBe(true);
        expect(verdict.severedParts).toBe(1);
    });

    it('the union of the same three buildings does NOT fit one piece — which is why it was wrong', () => {
        // Pin the old behaviour as the thing being fixed: hand the union in as a single part and it
        // reads as severed, though no building was touched.
        const union = [
            rect(at(5), lat(1), at(7), lat(3)),
            rect(at(8.5), lat(0.5), at(11.5), lat(1.5))
        ].reduce((acc, poly) => turf.union(acc, poly), rect(at(1), lat(1), at(3), lat(3)));
        const verdict = sweep.inspectDesignAgainstPieces([union], pieces, ops);
        expect(verdict.standsHere).toBe(true);
        expect(verdict.severed).toBe(true);
    });

    it('a park is one part, so divided ground reaches it whatever its shape', () => {
        const park = [rect(at(8.5), lat(0.5), at(11.5), lat(3))];   // spans the cut
        expect(sweep.inspectDesignAgainstPieces(park, pieces, ops).severed).toBe(true);
    });

    it('a shared boundary is not standing on the ground', () => {
        // Touching the piece edge-on: a sliver under the threshold must not count.
        const neighbour = [rect(at(7), lat(0), at(8), lat(4))];
        expect(sweep.inspectDesignAgainstPieces(neighbour, pieces, ops).standsHere).toBe(false);
    });

    it('says nothing when there is nothing to judge', () => {
        expect(sweep.inspectDesignAgainstPieces([], pieces, ops).standsHere).toBe(false);
        expect(sweep.inspectDesignAgainstPieces([parcelOne], [], ops).standsHere).toBe(false);
        expect(sweep.inspectDesignAgainstPieces([parcelOne], pieces, null).standsHere).toBe(false);
    });
});

describe('coordinated plots meeting road parcels', () => {
    const road = rect(at(4), lat(0), at(5), lat(4));

    it('keeps plots that meet the road only at their boundary', () => {
        expect(sweep.partsOverlapPieces([parcelOne], [road], ops)).toBe(false);
    });

    it('detects a road that actually crosses a plot', () => {
        const crossingRoad = rect(at(3), lat(0), at(5), lat(4));
        expect(sweep.partsOverlapPieces([parcelOne], [crossingRoad], ops)).toBe(true);
    });
});

// This helper used to be wired into boot replay as a second validity system. It parked any park on
// a cadastral parcel divided by a road even when the canonical live-ground resolver could place it,
// causing a full replay to restart and the shared-route loader to apply the same record again.
describe('the retired boot sweep stays out of materialization', () => {
    const manager = require('node:fs').readFileSync(
        new URL('../../frontend/js/proposal-manager.js', import.meta.url), 'utf8');

    it('does not alter the applied set or trigger another pass', () => {
        expect(manager).not.toContain('_parkRecordsInvalidatedByCorridors');
        expect(manager).not.toContain('applied set changed during replay');
        expect(manager).not.toContain('_replayInvalidated');
        expect(manager).toContain('preserveAppliedSet: true');
    });

    it('is not loaded by the page', () => {
        expect(require('node:fs').readFileSync(new URL('../../frontend/index.html', import.meta.url), 'utf8'))
            .not.toContain("'js/proposals/ground-sweep.js'");
    });
});
