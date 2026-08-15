// plan-order.js against the real production plan that could not be shared or replayed.
//
// The fixture is the live plan 97-104 as the server stores it (captured 2026-07-21). Under the
// current derived-id model two of its proposals are each other's ancestor, which is unsatisfiable,
// and three of its parent references name parcels that no longer exist anywhere. This suite asserts
// that geometry-derived ancestry and ordering resolve the same plan cleanly.
//
// See rethink-proposals.md §3.

import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const fixture = require('./fixtures/plan-97-104.json');

let planOrder;

beforeAll(() => {
    globalThis.turf = turf;
    planOrder = require('../../frontend/js/proposals/plan-order.js');
});

const proposals = () => fixture.proposals.map(p => ({
    id: p.id, goal: p.goal, createdAt: p.createdAt, title: p.title,
    footprint: p.footprint ? turf.feature(p.footprint) : null
}));

const baseParcels = () => fixture.baseParcels.map(b => ({ id: b.id, feature: turf.feature(b.geometry) }));

const byId = id => proposals().find(p => p.id === id);

describe('base-parcel ancestry', () => {
    it('anchors every proposal in the plan to real cadastral parcels', () => {
        const base = baseParcels();
        proposals().forEach(p => {
            const anc = planOrder.computeBaseAncestry(p.footprint, base);
            expect(anc.length, `#${p.id} ${p.title} has no base anchor`).toBeGreaterThan(0);
            anc.forEach(a => expect(a.id).not.toContain('#')); // never a derived id
        });
    });

    it('anchors the freeform building, which today declares only derived parents', () => {
        // #104's four declared parents are all derived — it is one of the three proposals that
        // cannot survive being opened in another browser.
        const declared = fixture.proposals.find(p => p.id === 104).declared;
        expect(declared.every(id => id.includes('#'))).toBe(true);

        const anc = planOrder.computeBaseAncestry(byId(104).footprint, baseParcels());
        expect(anc.map(a => a.id)).toEqual(['HR-339270-6804/1', 'HR-339270-6804/9']);
    });

    it('finds the affected owners a single derived parent hides', () => {
        // #103 declares ONE derived parcel; its geometry covers five base parcels, so five owners
        // are affected and only one is currently asked.
        expect(fixture.proposals.find(p => p.id === 103).declared).toHaveLength(1);
        const anc = planOrder.computeBaseAncestry(byId(103).footprint, baseParcels());
        expect(anc.length).toBe(5);
        expect(anc[0].id).toBe('HR-339270-823/1');
    });

    it('ignores shared-border slivers', () => {
        const base = baseParcels();
        const anc = planOrder.computeBaseAncestry(byId(97).footprint, base, { minAreaM2: 1e9 });
        expect(anc).toEqual([]);
    });

    it('repairs an exact-boundary topology failure instead of counting the parcel as absent', () => {
        // Regression for UPU Borovje: polygon-clipping could not close the intersection ring for
        // cadastral parcel 1791/69. The old catch returned 0, dropping 55,702 m2 and turning full
        // live coverage into 37%. A sub-millimetre buffer resolves only that coincident-edge
        // ambiguity, and the result remains capped by the two original operands.
        const realTurf = globalThis.turf;
        const footprint = { name: 'footprint' };
        const parcel = { name: 'parcel' };
        const repairedParcel = { name: 'repaired-parcel' };
        const hit = { name: 'intersection' };
        let exactAttempts = 0;
        globalThis.turf = {
            intersect(left, right) {
                if (left === footprint && right === parcel) {
                    exactAttempts += 1;
                    throw new Error('Unable to complete output ring');
                }
                if (left === footprint && right === repairedParcel) return hit;
                return null;
            },
            buffer(subject, distance, options) {
                expect(subject).toBe(parcel);
                expect(distance).toBe(0.0001);
                expect(options).toEqual({ units: 'meters' });
                return repairedParcel;
            },
            area(subject) {
                if (subject === hit) return 55702.2;
                if (subject === footprint) return 88994.8;
                if (subject === parcel) return 58226.1;
                return 0;
            }
        };
        try {
            expect(planOrder.intersectionArea(footprint, parcel)).toBe(55702.2);
            expect(exactAttempts).toBe(1);
        } finally {
            globalThis.turf = realTurf;
        }
    });
});

// The ancestry floor separates a REAL take from coordinate-rounding noise, and it belongs at the
// measured noise, not at a judgement about what size of take is worth registering. Measured on
// Zagreb fabric (2026-08-08): rounding noise between abutting cadastral parcels tops out near
// 0.1 m², while a corridor genuinely covering 0.755 m² of parcel 6804/5 was DISCARDED by the old
// 2 m² floor — so the road never cut that parcel and its corridor lay on ground someone else still
// owned, which then made the parcel unusable (taking it whole took road surface with it).
describe('ancestry floor sits at the measured noise, not above real takes', () => {
    const LAT = 45.80, LON = 15.96;
    const mLat = m => m / 111320;
    const mLon = m => m / (111320 * Math.cos(LAT * Math.PI / 180));
    const rect = (x0, y0, x1, y1) => turf.polygon([[
        [LON + mLon(x0), LAT + mLat(y0)],
        [LON + mLon(x1), LAT + mLat(y0)],
        [LON + mLon(x1), LAT + mLat(y1)],
        [LON + mLon(x0), LAT + mLat(y1)],
        [LON + mLon(x0), LAT + mLat(y0)]
    ]]);
    const overlapOf = (a, b) => { const hit = turf.intersect(a, b); return hit ? turf.area(hit) : 0; };
    const parcel = () => rect(0, 0, 40, 40);

    it('registers a genuine sub-2 m² take (the 6804/5 class)', () => {
        // A corridor edge lying 2 cm inside a 40 m parcel boundary: ~0.8 m² of real ground.
        const corridor = rect(-20, 0, 0.02, 40);
        const overlap = overlapOf(parcel(), corridor);
        expect(overlap).toBeGreaterThan(0.25);
        expect(overlap).toBeLessThan(2); // the old 2 m² floor silently discarded exactly this
        const anc = planOrder.computeBaseAncestry(corridor, [{ id: 'HR-339270-6804/5', feature: parcel() }]);
        expect(anc.map(a => a.id)).toEqual(['HR-339270-6804/5']);
    });

    it('still ignores float-scale noise along a shared border', () => {
        // 2.5 mm of overlap along the same 40 m border: ~0.1 m², the measured noise ceiling.
        const neighbour = rect(-40, 0, 0.0025, 40);
        const overlap = overlapOf(parcel(), neighbour);
        expect(overlap).toBeLessThan(0.25);
        const anc = planOrder.computeBaseAncestry(neighbour, [{ id: 'HR-339270-6804/5', feature: parcel() }]);
        expect(anc).toEqual([]);
    });
});

describe('apply order', () => {
    it('orders a shuffled plan identically without consulting geometry', () => {
        const shuffled = proposals().reverse();
        expect(planOrder.orderFormations(shuffled).map(p => p.id))
            .toEqual(planOrder.orderFormations(proposals()).map(p => p.id));
    });

    it('ignores obsolete local edit timestamps', () => {
        const older = { ...byId(97), localEditAt: '2026-08-06T13:30:00.000Z' };
        const newer = { ...byId(98) };
        expect(planOrder.orderFormations([newer, older]).map(p => p.id)).toEqual([97, 98]);
    });

    it('uses the numeric server row id as the deterministic timestamp tie-break', () => {
        const sameTime = '2026-08-06T13:30:00.000Z';
        const records = [
            { id: 670, proposalId: 'c-z', createdAt: sameTime },
            { id: 663, proposalId: 'c-a', createdAt: sameTime }
        ];
        expect(planOrder.orderFormations(records).map(p => p.id)).toEqual([663, 670]);
    });
});

describe('cadastre ancestry', () => {
    it('strips a derived suffix back to the cadastral parcel', () => {
        expect(planOrder.cadastreRootId('HR-339270-823/1#p-2g0teu3onpu-2')).toBe('HR-339270-823/1');
        expect(planOrder.cadastreRootId('HR-339270-823/1')).toBe('HR-339270-823/1');
    });

    it('unwraps nested derived ids — a re-split of an already-split parcel', () => {
        expect(planOrder.cadastreRootId('HR-335649-371/1#p-a-10#p-b-3')).toBe('HR-335649-371/1');
        expect(planOrder.cadastreRootId('HR-339270-824_proposal_9')).toBe('HR-339270-824');
    });

    it('dedupes the roots of a declared parent list', () => {
        expect(planOrder.cadastreIdsFromDeclared([
            'HR-339270-823/1#p-a-1', 'HR-339270-823/1#p-a-2', 'HR-339270-824', null, ''
        ])).toEqual(['HR-339270-823/1', 'HR-339270-824']);
    });

    it('uses geometry only and ignores an unrelated declared parent', () => {
        // #104 declares four derived parents whose roots are 6804/1, 6804/5 and 6804/9. Geometry
        // finds only 6804/1 and 6804/9. The third is a stale declaration and must not become a
        // false ground claim.
        const p = fixture.proposals.find(x => x.id === 104);
        const ids = planOrder.computeCadastreParcelIds(
            { parentParcelIds: p.declared, geometry: p.footprint },
            baseParcels()
        );
        expect(ids).toContain('HR-339270-6804/1');
        expect(ids).toContain('HR-339270-6804/9');
        expect(ids).not.toContain('HR-339270-6804/5');
        expect(ids.every(id => !id.includes('#'))).toBe(true);
    });

    it('refuses to infer cadastral ancestry when geometry is unavailable', () => {
        const ids = planOrder.computeCadastreParcelIds(
            { parentParcelIds: ['HR-339270-823/1#p-a-1'], geometry: null }, baseParcels());
        expect(ids).toEqual([]);
    });

    it('extracts a footprint from every typology in the plan', () => {
        fixture.proposals.forEach(p => {
            const built = planOrder.footprintOf({ geometry: p.footprint });
            expect(built, `#${p.id} ${p.title}`).toBeTruthy();
        });
    });
});

describe('road footprints', () => {
    it('prefers the authored derived polygon', () => {
        const square = turf.polygon([[[15.96, 45.80], [15.96, 45.801], [15.961, 45.801], [15.961, 45.80], [15.96, 45.80]]]);
        const fp = planOrder.footprintOf({
            roadProposal: {
                definition: { width: 10, points: [{ lat: 45.9, lng: 16.0 }, { lat: 45.91, lng: 16.01 }], polygon: square.geometry }
            }
        });
        expect(turf.area(fp)).toBeCloseTo(turf.area(square), 0);
    });

    it('delegates centerline derivation to the canonical corridor builder', () => {
        const square = turf.polygon([[[15.96, 45.80], [15.96, 45.801], [15.961, 45.801], [15.961, 45.80], [15.96, 45.80]]]);
        globalThis.corridorSurfaceFootprintForDefinition = () => square.geometry;
        try {
            const fp = planOrder.footprintOf({ roadProposal: { definition: { width: 10, points: [] } } });
            expect(turf.area(fp)).toBeCloseTo(turf.area(square), 0);
        } finally {
            delete globalThis.corridorSurfaceFootprintForDefinition;
        }
    });

    it('returns nothing for a record carrying only bounds', () => {
        expect(planOrder.footprintOf({ bounds: [1, 2, 3, 4] })).toBeNull();
    });
});
