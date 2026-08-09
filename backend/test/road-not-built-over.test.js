// Nothing is built over a street.
//
// A road, once placed, IS a parcel, and no square, park, lake or building may stand on it — not
// "may not cut it in two", may not touch it. The guard that enforces this is also where the
// centerline used to leak in: the rule it replaced judged a take by trimming the road's
// CENTERLINE, so a road whose parcel had been shaped (edited, migrated, hand-drawn) was judged
// against a line that was not its ground. These tests pin both halves — the rule, and the fact
// that the parcel is what answers.
import { describe, it, expect, beforeAll } from 'vitest';
import * as turf from '@turf/turf';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const roadApply = require('../../frontend/js/proposals/apply/road.js');

const box = (west, south, width, height) => ({
    type: 'Polygon',
    coordinates: [[
        [west, south], [west + width, south], [west + width, south + height], [west, south + height], [west, south]
    ]]
});

// The road HOLDS a narrow band…
const HELD_PARCEL = box(15.9700, 45.80000, 0.0013, 0.00009);
// …while its centerline, buffered at the record's width, would cover a much wider one. A take in
// the gap between them touches the corridor a rebuild would produce, but not the road's ground.
const CENTERLINE_BAND = box(15.9700, 45.79970, 0.0013, 0.00070);
const IN_THE_GAP = box(15.97050, 45.79975, 0.0002, 0.0001);
const ON_THE_PARCEL = box(15.97050, 45.80002, 0.0002, 0.00005);
const ABUTTING = box(15.97050, 45.80009, 0.0002, 0.00005); // shares the north edge, zero area

let applied;

const road = (overrides = {}) => ({
    proposalId: 'road-1',
    title: 'Ulica',
    applied: true,
    roadProposal: { definition: { width: 60, points: [[{ lat: 45.8, lng: 15.97 }, { lat: 45.8, lng: 15.9713 }]], polygon: HELD_PARCEL } },
    ...overrides
});

beforeAll(() => {
    globalThis.turf = turf;
    globalThis.proposalStorage = { getAllProposals: () => applied };
    globalThis.isProposalCurrentlyApplied = p => !!(p && p.applied);
    // What a centerline rebuild would hand back — the guard must never consult it.
    globalThis.corridorSurfaceFootprintForDefinition = () => CENTERLINE_BAND;
});

const check = (geometry, exclude) => roadApply._appliedRoadOverlappedByTaking(geometry, exclude);

describe('_appliedRoadOverlappedByTaking', () => {
    it('refuses a take that stands on the road, and says how much', () => {
        applied = [road()];

        const hit = check(ON_THE_PARCEL);

        expect(hit).toBeTruthy();
        expect(hit.proposal.proposalId).toBe('road-1');
        expect(hit.overlapM2).toBeGreaterThan(1);
    });

    it('allows a take that merely abuts the street', () => {
        applied = [road()];

        // Sharing an edge is ordinary composition — plots line streets, that is what streets are for.
        expect(check(ABUTTING)).toBeNull();
    });

    it('judges the PARCEL the road holds, never the corridor its centerline would rebuild', () => {
        applied = [road()];

        // IN_THE_GAP sits inside the centerline band and outside the held parcel. The old
        // centerline-based rule would have refused here; the ground is not the road's.
        expect(turf.area(turf.intersect(
            { type: 'Feature', properties: {}, geometry: IN_THE_GAP },
            { type: 'Feature', properties: {}, geometry: CENTERLINE_BAND }))).toBeGreaterThan(1);
        expect(check(IN_THE_GAP)).toBeNull();
    });

    it('falls back to the derived corridor for a road that has no parcel yet', () => {
        const r = road();
        r.roadProposal.definition.polygon = null;
        applied = [r];

        // Same ground, opposite answer: with no stored parcel the corridor IS the road.
        expect(check(IN_THE_GAP)).toBeTruthy();
    });

    it('ignores roads that are not applied, and the taker itself', () => {
        applied = [road({ applied: false })];
        expect(check(ON_THE_PARCEL)).toBeNull();

        applied = [road()];
        expect(check(ON_THE_PARCEL, 'road-1')).toBeNull();
    });

    it('ignores a proposal that is not a road at all', () => {
        applied = [{ proposalId: 'park-1', applied: true, structureProposal: { geometry: HELD_PARCEL } }];

        expect(check(ON_THE_PARCEL)).toBeNull();
    });
});
