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
