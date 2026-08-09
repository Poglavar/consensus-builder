// ownership-flow.js — the declared ownership flow of a formation (per crossed base parcel: ceded
// area + destination) and the effect fingerprint consent binds to (rethink-proposals.md §9, §11).

import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let flowApi;
let planOrder;
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
    planOrder = require('../../frontend/js/proposals/plan-order.js');
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
        expect(flowApi.destinationForGoal('reparcellization')).toBe('mapping');
        expect(flowApi.destinationForGoal('decide-later')).toBe('undecided');
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

describe('effectFingerprintOf', () => {
    const makeRoad = () => ({
        goal: 'road-track',
        geometry: JSON.parse(JSON.stringify(STRIP.geometry)),
        ownershipFlow: [
            { parcelId: 'HR-1-E', cededM2: 300, destination: 'public' },
            { parcelId: 'HR-1-P', cededM2: 1700, destination: 'public' }
        ]
    });

    it('is stable across identical proposals and flow ordering', () => {
        const a = flowApi.effectFingerprintOf(makeRoad());
        const reordered = makeRoad();
        reordered.ownershipFlow.reverse();
        expect(a).toMatch(/^e-/);
        expect(flowApi.effectFingerprintOf(reordered)).toBe(a);
    });

    it('survives sub-meter coordinate jitter (surveyor drift must not void consent)', () => {
        const jittered = makeRoad();
        jittered.geometry.coordinates[0][0][0] += 1e-8;
        expect(flowApi.effectFingerprintOf(jittered)).toBe(flowApi.effectFingerprintOf(makeRoad()));
    });

    it('changes when the footprint moves materially', () => {
        const moved = makeRoad();
        moved.geometry.coordinates[0] = moved.geometry.coordinates[0].map(([lng, lat]) => [lng + 0.0005, lat]);
        expect(flowApi.effectFingerprintOf(moved)).not.toBe(flowApi.effectFingerprintOf(makeRoad()));
    });

    it('changes when a cession changes, even with the footprint untouched', () => {
        const cheaper = makeRoad();
        cheaper.ownershipFlow[1].cededM2 = 900;
        expect(flowApi.effectFingerprintOf(cheaper)).not.toBe(flowApi.effectFingerprintOf(makeRoad()));
    });

    it('is null for content-only proposals (they bind to the content fingerprint instead)', () => {
        expect(flowApi.effectFingerprintOf({ goal: 'urban-rule', parentParcelIds: ['HR-1-P'] })).toBeNull();
    });

    it('ignores derived demolition scans but includes authored tunnel choices', () => {
        const bare = makeRoad();
        const reference = flowApi.effectFingerprintOf(bare);

        const withCut = makeRoad();
        withCut.roadProposal = { definition: { demolishedBuildings: [{ id: 'b1', geometry: {}, remainder: { type: 'Polygon' } }] } };
        const cutHash = flowApi.effectFingerprintOf(withCut);
        expect(cutHash).toBe(reference);

        const withDemolish = makeRoad();
        withDemolish.roadProposal = { definition: { demolishedBuildings: [{ id: 'b1', geometry: {} }] } }; // no remainder = full
        expect(flowApi.effectFingerprintOf(withDemolish)).toBe(reference);

        const withTunnel = makeRoad();
        withTunnel.roadProposal = { definition: { tunnels: [{ edgeKey: 'e1', buildingIds: ['b1'] }] } };
        expect(flowApi.effectFingerprintOf(withTunnel)).not.toBe(reference);
        expect(flowApi.effectFingerprintOf(withTunnel)).not.toBe(cutHash);

        // Empty record arrays are the same effect as no records at all.
        const withEmpty = makeRoad();
        withEmpty.roadProposal = { definition: { demolishedBuildings: [], tunnels: [] } };
        expect(flowApi.effectFingerprintOf(withEmpty)).toBe(reference);
    });

    it('accepts a computed flow for never-published proposals via options', () => {
        const local = { goal: 'road-track', geometry: JSON.parse(JSON.stringify(STRIP.geometry)) };
        const flow = flowApi.computeOwnershipFlow(local, [{ id: 'HR-1-P', feature: PARCEL }]);
        const withFlow = flowApi.effectFingerprintOf(local, { ownershipFlow: flow });
        const without = flowApi.effectFingerprintOf(local);
        expect(withFlow).toMatch(/^e-/);
        expect(withFlow).not.toBe(without);
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

describe('consent validity against the current effect (§12 step 4)', () => {
    const HASH = 'e-abc123';
    const OTHER = 'e-zzz999';

    it('a record binds to its hash; pre-mechanism records always count', () => {
        expect(flowApi.isAcceptanceRecordValid({ effectHash: HASH }, HASH)).toBe(true);
        expect(flowApi.isAcceptanceRecordValid({ effectHash: HASH }, OTHER)).toBe(false);
        expect(flowApi.isAcceptanceRecordValid({ acceptedAt: 'x' }, HASH)).toBe(true);
        expect(flowApi.isAcceptanceRecordValid({ effectHash: HASH }, null)).toBe(true);
    });

    const makeProposal = (hash) => ({
        proposalId: 'p1',
        acceptedParcelIds: ['HR-1-A', 'HR-1-B', 'HR-1-LEGACY'],
        ownerAcceptances: {
            'HR-1-A': {
                owners: {}, ownerOrder: ['o1', 'o2'],
                acceptedOwnerKeys: ['o1', 'o2'],
                acceptedBy: { o1: { effectHash: hash }, o2: { effectHash: hash } }
            },
            'HR-1-B': {
                owners: {}, ownerOrder: ['o3'],
                acceptedOwnerKeys: ['o3'],
                acceptedBy: { o3: { effectHash: OTHER } }
            }
        }
    });

    it('an edit lapses only the acceptances given to a different effect', () => {
        const proposal = makeProposal(HASH);
        const result = flowApi.refreshAcceptanceValidity(proposal, HASH);
        expect(result.lapsedOwners).toBe(1); // o3 accepted a different effect
        expect(proposal.acceptedParcelIds).toContain('HR-1-A');
        expect(proposal.acceptedParcelIds).not.toContain('HR-1-B');
        // Not governed by any owner entry — the plain-path acceptance is untouched.
        expect(proposal.acceptedParcelIds).toContain('HR-1-LEGACY');
        // The record itself is preserved: consent history is immutable.
        expect(proposal.ownerAcceptances['HR-1-B'].acceptedBy.o3.effectHash).toBe(OTHER);
    });

    it('an edit back to the accepted effect revalidates automatically', () => {
        const proposal = makeProposal(HASH);
        flowApi.refreshAcceptanceValidity(proposal, HASH);
        expect(proposal.acceptedParcelIds).not.toContain('HR-1-B');
        const back = flowApi.refreshAcceptanceValidity(proposal, OTHER);
        // Now o3's consent matches again — and o1/o2's lapses instead.
        expect(back.lapsedOwners).toBe(2);
        expect(proposal.acceptedParcelIds).toContain('HR-1-B');
        expect(proposal.acceptedParcelIds).not.toContain('HR-1-A');
    });

    it('records without hashes keep the pre-mechanism behaviour: nothing ever lapses', () => {
        const proposal = makeProposal(HASH);
        delete proposal.ownerAcceptances['HR-1-B'].acceptedBy.o3.effectHash;
        delete proposal.ownerAcceptances['HR-1-A'].acceptedBy.o1.effectHash;
        delete proposal.ownerAcceptances['HR-1-A'].acceptedBy.o2.effectHash;
        const result = flowApi.refreshAcceptanceValidity(proposal, OTHER);
        expect(result.lapsedOwners).toBe(0);
        expect(proposal.acceptedParcelIds.sort()).toEqual(['HR-1-A', 'HR-1-B', 'HR-1-LEGACY']);
    });
});
