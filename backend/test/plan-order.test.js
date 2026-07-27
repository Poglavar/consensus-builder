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

describe('constraint graph', () => {
    it('constrains only the fabric-changers whose footprints actually intersect', () => {
        const { edges } = planOrder.buildConstraintGraph(proposals());
        const pairs = edges.map(e => [e.from, e.to].sort((a, b) => a - b).join('-')).sort();
        expect(pairs).toEqual(['97-98', '98-102']);
    });

    it('records the intersection area that makes each constraint real', () => {
        const { edges } = planOrder.buildConstraintGraph(proposals());
        const find = (a, b) => edges.find(e => (e.from === a && e.to === b) || (e.from === b && e.to === a));
        // Measured: #97 x #98 = 128 m², #98 x #102 = 15 m².
        expect(find(97, 98).intersectionM2).toBeGreaterThan(120);
        expect(find(97, 98).intersectionM2).toBeLessThan(140);
        expect(find(98, 102).intersectionM2).toBeGreaterThan(10);
        expect(find(98, 102).intersectionM2).toBeLessThan(20);
    });

    it('leaves the deadlocked pair completely unrelated', () => {
        // #100 and #102 are each other's ancestor under the derived-id model — an unsatisfiable
        // cycle that made five proposals permanently unuploadable. Geometrically they only ABUT:
        // the raw intersection is ~0.0012 m², a sliver off their shared border, four orders of
        // magnitude below the 2 m² noise floor. Compare the pairs that do constrain: 128 and 15 m².
        const abut = planOrder.intersectionArea(byId(100).footprint, byId(102).footprint);
        expect(abut).toBeLessThan(0.01);
        expect(abut).toBeLessThan(planOrder.MIN_INTERSECTION_M2);

        const { edges } = planOrder.buildConstraintGraph(proposals());
        const between = edges.find(e =>
            (e.from === 100 && e.to === 102) || (e.from === 102 && e.to === 100));
        expect(between).toBeUndefined();
    });

    it('never constrains an overlay — overlays consume nothing', () => {
        const { edges, fabricIds } = planOrder.buildConstraintGraph(proposals());
        expect(fabricIds.sort((a, b) => a - b)).toEqual([97, 98, 100, 102]);
        const overlayIds = [99, 101, 103, 104];
        edges.forEach(e => {
            expect(overlayIds).not.toContain(e.from);
            expect(overlayIds).not.toContain(e.to);
        });
    });
});

describe('apply order', () => {
    it('produces an order that satisfies every constraint', () => {
        const result = planOrder.resolveApplyOrder(proposals());
        expect(result.violated).toEqual([]);
        expect(result.order).toHaveLength(8);
    });

    it('is acyclic by construction — creation time is a total order', () => {
        // The old model's cycle exists in this very fixture, via derived ids.
        const derivedEdges = [];
        fixture.proposals.forEach(p => p.declared.filter(id => id.includes('#')).forEach(id => {
            const m = id.match(/#(.+)-\d+$/);
            if (m) derivedEdges.push([m[1], p.id]);
        }));
        expect(derivedEdges.length).toBeGreaterThan(0);

        // The new model cannot express a cycle: every edge runs earlier -> later in one total order.
        const { edges } = planOrder.buildConstraintGraph(proposals());
        const created = new Map(fixture.proposals.map(p => [p.id, Date.parse(p.createdAt)]));
        edges.forEach(e => expect(created.get(e.from)).toBeLessThanOrEqual(created.get(e.to)));
    });

    it('reports which fabric-changers are free of any constraint', () => {
        const result = planOrder.resolveApplyOrder(proposals());
        // #100 is a road that touches no other fabric-changer, so nothing orders it.
        expect(result.unconstrained).toContain(100);
        expect(result.overlays.sort((a, b) => a - b)).toEqual([99, 101, 103, 104]);
    });

    it('orders a shuffled plan identically — the result does not depend on input order', () => {
        const shuffled = proposals().reverse();
        expect(planOrder.resolveApplyOrder(shuffled).order)
            .toEqual(planOrder.resolveApplyOrder(proposals()).order);
    });
});

describe('cadastre ancestry', () => {
    it('strips a derived suffix back to the cadastral parcel', () => {
        expect(planOrder.cadastreRootId('HR-339270-823/1#p-2g0teu3onpu-2')).toBe('HR-339270-823/1');
        expect(planOrder.cadastreRootId('HR-339270-823/1')).toBe('HR-339270-823/1');
    });

    it('unwraps nested derived ids — a re-split of an already-split parcel', () => {
        expect(planOrder.cadastreRootId('HR-335649-371/1#p-a-10#p-b-3')).toBe('HR-335649-371/1');
    });

    it('dedupes the roots of a declared parent list', () => {
        expect(planOrder.cadastreIdsFromDeclared([
            'HR-339270-823/1#p-a-1', 'HR-339270-823/1#p-a-2', 'HR-339270-824', null, ''
        ])).toEqual(['HR-339270-823/1', 'HR-339270-824']);
    });

    it('prefers geometry but never records less land than the proposal declared', () => {
        // #104 declares four derived parents whose roots are 6804/1, 6804/5 and 6804/9. Geometry
        // finds only 6804/1 and 6804/9 — the third is declared but not actually covered, and must
        // still be kept so a proposal never claims LESS than it did before.
        const p = fixture.proposals.find(x => x.id === 104);
        const ids = planOrder.computeCadastreParcelIds(
            { parentParcelIds: p.declared, geometry: p.footprint },
            baseParcels()
        );
        expect(ids).toContain('HR-339270-6804/1');
        expect(ids).toContain('HR-339270-6804/9');
        expect(ids).toContain('HR-339270-6804/5'); // declared-only, preserved
        expect(ids.every(id => !id.includes('#'))).toBe(true);
    });

    it('recovers cadastral ancestry for a proposal whose geometry is unavailable', () => {
        const ids = planOrder.computeCadastreParcelIds(
            { parentParcelIds: ['HR-339270-823/1#p-a-1'], geometry: null }, baseParcels());
        expect(ids).toEqual(['HR-339270-823/1']);
    });

    it('extracts a footprint from every typology in the plan', () => {
        fixture.proposals.forEach(p => {
            const built = planOrder.footprintOf({ geometry: p.footprint });
            expect(built, `#${p.id} ${p.title}`).toBeTruthy();
        });
    });
});

describe('legacy road footprints', () => {
    it('buffers a centerline when the record predates stored corridor polygons', () => {
        // Roads drawn before the corridor rework store only points + width. Without this fallback
        // 29 of 94 zagreb rows had no footprint at all and could not be given cadastral ancestry.
        const legacy = {
            roadProposal: {
                definition: {
                    width: 10,
                    points: [{ lat: 45.8053, lng: 15.9636 }, { lat: 45.8060, lng: 15.9650 }]
                }
            }
        };
        const fp = planOrder.footprintOf(legacy);
        expect(fp).toBeTruthy();
        const area = turf.area(fp);
        // ~10 m wide over ~135 m, plus the rounded caps.
        expect(area).toBeGreaterThan(1000);
        expect(area).toBeLessThan(2500);
    });

    it('handles a multi-segment centerline', () => {
        const fp = planOrder.footprintOf({
            definition: {
                width: 8,
                points: [
                    [{ lat: 45.8053, lng: 15.9636 }, { lat: 45.8058, lng: 15.9640 }],
                    [{ lat: 45.8070, lng: 15.9660 }, { lat: 45.8075, lng: 15.9665 }]
                ]
            }
        });
        expect(fp).toBeTruthy();
        expect(turf.area(fp)).toBeGreaterThan(500);
    });

    it('prefers a stored polygon over the buffered approximation', () => {
        const square = turf.polygon([[[15.96, 45.80], [15.96, 45.801], [15.961, 45.801], [15.961, 45.80], [15.96, 45.80]]]);
        const fp = planOrder.footprintOf({
            definition: { width: 10, points: [{ lat: 45.9, lng: 16.0 }, { lat: 45.91, lng: 16.01 }], polygon: square.geometry }
        });
        expect(turf.area(fp)).toBeCloseTo(turf.area(square), 0);
    });

    it('returns nothing for a record carrying only bounds', () => {
        expect(planOrder.footprintOf({ bounds: [1, 2, 3, 4] })).toBeNull();
    });
});

describe('parcel formation (A7)', () => {
    const parcelsOf = () => baseParcels();

    it('reports a pure merge when the footprint swallows a parcel whole', () => {
        // #97's footprint is the whole of HR-339270-824.
        const plan = planOrder.formationPlan(byId(97).footprint, parcelsOf());
        expect(plan.merged.map(m => m.id)).toEqual(['HR-339270-824']);
        expect(plan.cut).toHaveLength(0);
    });

    it('reports cuts, and what each one leaves behind', () => {
        const plan = planOrder.formationPlan(byId(104).footprint, parcelsOf());
        expect(plan.merged).toHaveLength(0);
        expect(plan.cut.map(c => c.id).sort()).toEqual(['HR-339270-6804/1', 'HR-339270-6804/9']);
        const big = plan.cut.find(c => c.id === 'HR-339270-6804/1');
        expect(big.takenM2).toBeGreaterThan(3400);
        expect(big.remainderM2).toBeGreaterThan(9000);
    });

    it('judges a remainder against its PARENT, not against a fixed compactness', () => {
        // The trap: HR-339270-6804/1 scores 0.083 untouched — long and thin is normal for a real
        // cadastral parcel. A remainder at 0.13 is an improvement, and must not be called a sliver.
        const plan = planOrder.formationPlan(byId(101).footprint, parcelsOf());
        const parent = plan.cut.find(c => c.id === 'HR-339270-6804/1');
        expect(parent.parentCompactness).toBeLessThan(0.15);
        const biggest = parent.pieces[0];
        expect(biggest.compactness).toBeGreaterThan(parent.parentCompactness);
        expect(plan.degraded.some(d => d.id === 'HR-339270-6804/1')).toBe(false);
    });

    it('still flags a genuinely tiny remainder', () => {
        const plan = planOrder.formationPlan(byId(103).footprint, parcelsOf());
        expect(plan.tiny.map(t => t.id)).toContain('HR-339270-823/6');
        expect(plan.tiny.find(t => t.id === 'HR-339270-823/6').areaM2).toBeLessThan(50);
    });

    it('flags a parcel shattered into disconnected pieces', () => {
        const plan = planOrder.formationPlan(byId(100).footprint, parcelsOf());
        expect(plan.shattered.length).toBeGreaterThan(0);
        const worst = plan.shattered.find(c => c.id === 'HR-339270-6804/1');
        expect(worst.pieces.length).toBeGreaterThan(2);
    });

    it('reports footprint area that no cadastral parcel covers', () => {
        // The precondition for A7: a target parcel can only be formed from cadastral land.
        const offMap = turf.buffer(turf.point([16.9, 46.4]), 20, { units: 'meters' });
        const plan = planOrder.formationPlan(offMap, parcelsOf());
        expect(plan.uncoveredM2).toBeGreaterThan(0);
        expect(plan.merged).toHaveLength(0);
        expect(plan.cut).toHaveLength(0);
    });
});

describe('rewriteParentParcelIds', () => {
    const makeProposal = () => ({
        proposalId: 'p-x',
        parentParcelIds: ['HR-339270-823/1#p-ghost-2', 'HR-339270-824'],
        roadProposal: { parentParcelIds: ['HR-339270-823/1#p-ghost-2'], definition: { width: 12 } },
        buildingProposal: { parentParcelIds: [] }
    });

    it('rewrites the top-level list and every typology sub-object that exists', () => {
        const proposal = makeProposal();
        const touched = planOrder.rewriteParentParcelIds(proposal, ['HR-339270-823/1', 'HR-339270-6804/1']);
        expect(touched).toEqual([
            'parentParcelIds',
            'roadProposal.parentParcelIds',
            'buildingProposal.parentParcelIds'
        ]);
        expect(proposal.parentParcelIds).toEqual(['HR-339270-823/1', 'HR-339270-6804/1']);
        expect(proposal.roadProposal.parentParcelIds).toEqual(['HR-339270-823/1', 'HR-339270-6804/1']);
        expect(proposal.buildingProposal.parentParcelIds).toEqual(['HR-339270-823/1', 'HR-339270-6804/1']);
        // Absent sub-objects must not be invented.
        expect(proposal.structureProposal).toBeUndefined();
        expect(proposal.decideLaterProposal).toBeUndefined();
        expect(proposal.reparcellization).toBeUndefined();
    });

    it('hands each list its own copy, not a shared array', () => {
        const proposal = makeProposal();
        planOrder.rewriteParentParcelIds(proposal, ['HR-1']);
        proposal.roadProposal.parentParcelIds.push('mutation');
        expect(proposal.parentParcelIds).toEqual(['HR-1']);
    });

    it('is a no-op without a proposal or without ids', () => {
        expect(planOrder.rewriteParentParcelIds(null, ['HR-1'])).toEqual([]);
        const proposal = makeProposal();
        expect(planOrder.rewriteParentParcelIds(proposal, [])).toEqual([]);
        expect(planOrder.rewriteParentParcelIds(proposal, null)).toEqual([]);
        expect(proposal.parentParcelIds).toEqual(['HR-339270-823/1#p-ghost-2', 'HR-339270-824']);
    });

    it('coerces ids to strings and drops empties', () => {
        const proposal = { parentParcelIds: ['old'] };
        planOrder.rewriteParentParcelIds(proposal, [42, '', null, 'HR-2']);
        expect(proposal.parentParcelIds).toEqual(['42', 'HR-2']);
    });
});
