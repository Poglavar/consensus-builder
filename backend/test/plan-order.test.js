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
