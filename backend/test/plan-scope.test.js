// Compare plans on one parcel (frontend/js/proposals/plan-scope.js): which parcels the compared plans
// stand on, and a prepared plan narrowed to one of them, measured by the same yield arithmetic.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const Scope = require('../../frontend/js/proposals/plan-scope.js');
const Yield = require('../../frontend/js/proposals/plan-yield.js');

const ops = { intersect: (a, b) => turf.intersect(a, b), areaOf: feature => Yield.geometryAreaM2(feature) };
// A box in degrees around Alatau; 0.001° is roughly 80 m east and 111 m north there.
const box = (w, s, e, n, properties = {}) => turf.bboxPolygon([w, s, e, n], { properties });
const X = 77.09, Y = 43.79;
const parcelA = box(X, Y, X + 0.002, Y + 0.002, { parcelId: 'A', parcelNumber: '03341030011' });
const parcelB = box(X + 0.002, Y, X + 0.004, Y + 0.002, { parcelId: 'B', parcelNumber: '03341030012' });
const building = (w, s, e, n, floors) => box(w, s, e, n, { height: floors * 3.2, floors });
// A tower across the A|B edge, half on each, and one wholly on B.
const straddling = building(X + 0.0019, Y + 0.0005, X + 0.0021, Y + 0.0007, 20);
const onB = building(X + 0.003, Y + 0.0005, X + 0.0032, Y + 0.0007, 16);
const snapshotOf = (records, cadastral) => ({
    plan: { content: { title: 'Towers' } }, records, cadastralFeatures: cadastral,
    materializedFeatures: [box(X + 0.001, Y, X + 0.003, Y + 0.002, { parcelId: 'A#piece', producedByProposalId: 'park', structureType: 'park' })],
    corridorFeatures: [], landFeature: box(X + 0.0005, Y, X + 0.0035, Y + 0.002),
    land: { publicLandM2: 1 }, remaining: [], units: { designs: {} }, groundError: 'old', unitsCounting: false
});

describe('the parcels compared plans stand on', () => {
    it('lists each parcel once, those under every plan first, then the larger', () => {
        const big = box(X, Y, X + 0.004, Y + 0.004, { parcelId: 'C' });
        const list = Scope.parcelsOf([snapshotOf([], [parcelA, big]), snapshotOf([], [parcelA, parcelB])], ops);
        expect(list.map(p => [p.id, p.plans])).toEqual([['A', 2], ['C', 1], ['B', 1]]);
        expect(list[0].number).toBe('03341030011');
        expect(list[0].areaM2).toBeGreaterThan(0);
    });
});

describe('a plan narrowed to one parcel', () => {
    const records = [
        { proposalId: 'tower', cadastreParcelIds: ['A', 'B'], geometry: { buildings: [straddling] } },
        { proposalId: 'other', cadastreParcelIds: ['B'], geometry: { buildings: [onB] } }
    ];
    const whole = snapshotOf(records, [parcelA, parcelB]);

    it('keeps the designs declared on the parcel, with only their part there', () => {
        const onA = Scope.toParcel(whole, parcelA, ops);
        expect(onA.scopeParcelId).toBe('A');
        expect(onA.records.map(r => r.proposalId)).toEqual(['tower']);
        const part = onA.records[0].geometry.buildings[0];
        expect(part.properties.floors).toBe(20);
        expect(ops.areaOf(part) / ops.areaOf(straddling)).toBeCloseTo(0.5, 2);
        expect(onA.cadastralFeatures.map(f => f.properties.parcelId)).toEqual(['A']);
        // The plan's land and its formed pieces stop at the parcel's edge.
        expect(ops.areaOf(onA.landFeature)).toBeCloseTo(ops.areaOf(turf.intersect(whole.landFeature, parcelA)), 0);
        expect(ops.areaOf(onA.materializedFeatures[0])).toBeCloseTo(ops.areaOf(whole.materializedFeatures[0]) / 2, -1);
        // What was measured over the whole plan is not carried into the parcel's figures.
        for (const key of ['land', 'remaining', 'units', 'groundError', 'unitsCounting']) expect(onA).not.toHaveProperty(key);
        // The record given in stays as it was.
        expect(records[0].geometry.buildings[0]).toBe(straddling);
    });

    it('measures the part on the parcel with the same yield arithmetic as the whole plan', () => {
        const all = Yield.planYield(whole.records).total;
        const yieldA = Yield.planYield(Scope.toParcel(whole, parcelA, ops).records).total;
        const yieldB = Yield.planYield(Scope.toParcel(whole, parcelB, ops).records).total;
        expect(all.grossFloorAreaM2).toBeCloseTo(ops.areaOf(straddling) * 20 + ops.areaOf(onB) * 16, 0);
        expect(yieldA.grossFloorAreaM2).toBeCloseTo(ops.areaOf(straddling) / 2 * 20, -1);
        expect(yieldA.grossFloorAreaM2 + yieldB.grossFloorAreaM2).toBeCloseTo(all.grossFloorAreaM2, -1);
        expect(yieldA.buildings).toBe(1);
        expect(yieldB.buildings).toBe(2);
    });

    it('leaves a plan that does not reach the parcel with nothing there', () => {
        const elsewhere = box(X + 0.01, Y, X + 0.012, Y + 0.002, { parcelId: 'D' });
        const onD = Scope.toParcel(whole, elsewhere, ops);
        expect(onD.records).toEqual([]);
        expect(onD.landFeature).toBeNull();
        expect(onD.cadastralFeatures).toEqual([]);
        expect(Yield.planYield(onD.records).total.grossFloorAreaM2).toBe(0);
    });

    it('cuts a park or square to the parcel too', () => {
        const park = { proposalId: 'park', cadastreParcelIds: ['A', 'B'], structureProposal: { kind: 'park', geometry: box(X + 0.001, Y, X + 0.003, Y + 0.002).geometry } };
        const onA = Scope.recordOn(park, parcelA, ops);
        expect(Yield.geometryAreaM2(onA.structureProposal.geometry)).toBeCloseTo(Yield.geometryAreaM2(park.structureProposal.geometry) / 2, -1);
    });
});
