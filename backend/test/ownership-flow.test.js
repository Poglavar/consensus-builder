// ownership-flow.js — the declared ownership flow of a formation (per crossed base parcel: ceded
// area + destination) and its replay comparison (rethink-proposals.md §9, §11). No per-design
// consent binds to it: owners decide on agreements (plan-design-agreement.md, M2).

import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let flowApi;
let t;

// A lon/lat square as a GeoJSON feature. Sizes are picked so areas are hundreds-to-thousands of
// m² at Zagreb's latitude — far above the 2 m² noise floor.
function square(lngWest, latSouth, lngWidth, latHeight) {
    return {
        type: 'Feature',
        properties: {},
        geometry: {
            type: 'Polygon',
            coordinates: [[
                [lngWest, latSouth],
                [lngWest + lngWidth, latSouth],
                [lngWest + lngWidth, latSouth + latHeight],
                [lngWest, latSouth + latHeight],
                [lngWest, latSouth]
            ]]
        }
    };
}

const PARCEL = square(16.000, 45.800, 0.001, 0.001);          // ~8,600 m²
const PARCEL_EAST = square(16.001, 45.800, 0.001, 0.001);     // adjacent to the east
// A strip crossing PARCEL fully and reaching only 1/4 into PARCEL_EAST.
const STRIP = square(15.9995, 45.8004, 0.00175, 0.0002);

beforeAll(() => {
    globalThis.turf = require('@turf/turf');
    t = globalThis.turf;
    flowApi = require('../../frontend/js/proposals/ownership-flow.js');
});

describe('destinationForGoal', () => {
    it('declares one word per forming typology', () => {
        expect(flowApi.destinationForGoal('road-track')).toBe('public');
        expect(flowApi.destinationForGoal('park')).toBe('public');
        expect(flowApi.destinationForGoal('square')).toBe('public');
        expect(flowApi.destinationForGoal('lake')).toBe('public');
        expect(flowApi.destinationForGoal('station')).toBe('public');
        expect(flowApi.destinationForGoal('single')).toBe('proposer');
        expect(flowApi.destinationForGoal('buildings')).toBe('proposer');
        expect(flowApi.destinationForGoal('parcel-layout')).toBe('carry-over');
        expect(flowApi.destinationForGoal('reparcellization')).toBeNull();
    });

    it('content-only typologies have no formation', () => {
        expect(flowApi.destinationForGoal('urban-rule')).toBeNull();
        expect(flowApi.destinationForGoal('as-is')).toBeNull();
        expect(flowApi.destinationForGoal('ownership-transfer')).toBeNull();
        expect(flowApi.destinationForGoal('')).toBeNull();
        expect(flowApi.destinationForGoal(null)).toBeNull();
        expect(flowApi.hasFormation('road-track')).toBe(true);
        expect(flowApi.hasFormation('urban-rule')).toBe(false);
    });
});

describe('computeOwnershipFlow', () => {
    const baseParcels = [
        { id: 'HR-1-P', feature: PARCEL },
        { id: 'HR-1-E', feature: PARCEL_EAST }
    ];

    it('measures the ceded area per crossed parcel, largest first, with the goal destination', () => {
        const road = { goal: 'road-track', geometry: STRIP.geometry };
        const flow = flowApi.computeOwnershipFlow(road, baseParcels);
        expect(flow.map(f => f.parcelId)).toEqual(['HR-1-P', 'HR-1-E']);
        expect(flow.every(f => f.destination === 'public')).toBe(true);

        // The measured areas must match turf's own intersection, not a restatement.
        const expectedP = Math.round(t.area(t.intersect(STRIP, PARCEL)));
        const expectedE = Math.round(t.area(t.intersect(STRIP, PARCEL_EAST)));
        expect(expectedP).toBeGreaterThan(500);
        expect(expectedE).toBeGreaterThan(100);
        expect(Math.abs(flow[0].cededM2 - expectedP)).toBeLessThanOrEqual(2);
        expect(Math.abs(flow[1].cededM2 - expectedE)).toBeLessThanOrEqual(2);
        expect(flow[0].cededM2).toBeGreaterThan(flow[1].cededM2);
    });

    it('returns [] for content-only proposals and for proposals without geometry', () => {
        expect(flowApi.computeOwnershipFlow({ goal: 'urban-rule', geometry: STRIP.geometry }, baseParcels)).toEqual([]);
        expect(flowApi.computeOwnershipFlow({ goal: 'road-track' }, baseParcels)).toEqual([]);
        expect(flowApi.computeOwnershipFlow({ goal: 'road-track', geometry: STRIP.geometry }, [])).toEqual([]);
    });
});

describe('compareOwnershipFlows — replay fidelity (§11 first rung)', () => {
    const stamped = [
        { parcelId: 'HR-1-A', cededM2: 1700, destination: 'public' },
        { parcelId: 'HR-1-B', cededM2: 100, destination: 'public' },
        { parcelId: 'HR-1-C', cededM2: 40, destination: 'public' }
    ];

    it('identical flows are the same, sub-tolerance drift included', () => {
        const live = [
            { parcelId: 'HR-1-A', cededM2: 1703, destination: 'public' }, // 3 m² < 5% — noise
            { parcelId: 'HR-1-B', cededM2: 96, destination: 'public' },
            { parcelId: 'HR-1-C', cededM2: 40, destination: 'public' }
        ];
        expect(flowApi.compareOwnershipFlows(stamped, live).same).toBe(true);
    });

    it('a material cession change is reported with before/after', () => {
        const live = [
            { parcelId: 'HR-1-A', cededM2: 900, destination: 'public' },
            { parcelId: 'HR-1-B', cededM2: 100, destination: 'public' },
            { parcelId: 'HR-1-C', cededM2: 40, destination: 'public' }
        ];
        const diff = flowApi.compareOwnershipFlows(stamped, live);
        expect(diff.same).toBe(false);
        expect(diff.changed).toEqual([{ parcelId: 'HR-1-A', wasM2: 1700, nowM2: 900 }]);
    });

    it('a parcel missing from the live flow counts as removed only when it is actually loaded', () => {
        const live = stamped.filter(e => e.parcelId !== 'HR-1-A');
        const known = new Set(['HR-1-B', 'HR-1-C']); // A is not loaded here — unknown, not absent
        expect(flowApi.compareOwnershipFlows(stamped, live, { knownParcelIds: known }).same).toBe(true);
        const knownAll = new Set(['HR-1-A', 'HR-1-B', 'HR-1-C']);
        const diff = flowApi.compareOwnershipFlows(stamped, live, { knownParcelIds: knownAll });
        expect(diff.removed).toEqual([{ parcelId: 'HR-1-A', wasM2: 1700 }]);
    });

    it('new ground taken here that the publish never touched is reported as added', () => {
        const live = stamped.concat([{ parcelId: 'HR-1-D', cededM2: 200, destination: 'public' }]);
        const diff = flowApi.compareOwnershipFlows(stamped, live);
        expect(diff.added).toEqual([{ parcelId: 'HR-1-D', nowM2: 200 }]);
    });

    it('a destination change is a divergence even at identical area', () => {
        const live = stamped.map(e => e.parcelId === 'HR-1-B' ? { ...e, destination: 'proposer' } : e);
        const diff = flowApi.compareOwnershipFlows(stamped, live);
        expect(diff.same).toBe(false);
        expect(diff.changed[0].parcelId).toBe('HR-1-B');
    });
});
