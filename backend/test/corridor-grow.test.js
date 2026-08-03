// corridor-grow.js — the additive half of a road merge: which ground a grown corridor NEWLY
// covers, and how only the parcels under that ground are re-formed. Everything else must be
// left strictly alone (rethink-proposals.md §15.1).
import { describe, it, expect } from 'vitest';
import * as turf from '@turf/turf';

const grow = require('../../frontend/js/proposals/corridor-grow.js');

// Šibenik-ish latitudes so the metric areas are realistic; 0.001° ≈ 111 m north-south.
const box = (west, south, east, north) => ({
    type: 'Polygon',
    coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]]
});

const areaOf = geometry => turf.area({ type: 'Feature', properties: {}, geometry });

describe('pickMergeHost', () => {
    it('gives the drawing to the OLDEST road it touched', () => {
        const older = { proposalId: 'a', createdAt: '2026-08-01T10:00:00Z' };
        const newer = { proposalId: 'b', createdAt: '2026-08-03T10:00:00Z' };
        expect(grow.pickMergeHost([newer, older])).toBe(older);
        expect(grow.pickMergeHost([older, newer])).toBe(older);
    });

    it('never lets an undated record outrank a dated one', () => {
        const dated = { proposalId: 'a', createdAt: '2026-08-03T10:00:00Z' };
        const undated = { proposalId: 'b' };
        expect(grow.pickMergeHost([undated, dated])).toBe(dated);
    });

    it('returns null when nothing was touched', () => {
        expect(grow.pickMergeHost([])).toBeNull();
    });
});

describe('orderHostFirst', () => {
    it('puts the host first and keeps the rest in order', () => {
        const a = { id: 'a' }, b = { id: 'b' }, c = { id: 'c' };
        expect(grow.orderHostFirst([a, b, c], b)).toEqual([b, a, c]);
    });
});

describe('newGroundGeometry', () => {
    const existing = box(15.880, 43.730, 15.882, 43.731);

    it('returns only the ground the corridor did not already hold', () => {
        const grown = box(15.880, 43.730, 15.884, 43.731); // twice as long
        const delta = grow.newGroundGeometry(grown, [existing], turf);
        expect(delta).toBeTruthy();
        // The new half — less the 0.1 m tolerance strip along the ~111 m shared edge.
        const ideal = areaOf(grown) - areaOf(existing);
        expect(areaOf(delta)).toBeLessThan(ideal);
        expect(areaOf(delta)).toBeGreaterThan(ideal - 20);
    });

    it('is null when the drawing ran entirely inside the roads it joined', () => {
        const inside = box(15.8805, 43.7303, 15.8815, 43.7307);
        expect(grow.newGroundGeometry(inside, [existing], turf)).toBeNull();
    });

    it('is the whole footprint when there is nothing to subtract', () => {
        const grown = box(15.880, 43.730, 15.884, 43.731);
        expect(areaOf(grow.newGroundGeometry(grown, [], turf))).toBeCloseTo(areaOf(grown), -1);
    });

    it('does not call a few centimetres of re-outlined edge "new ground"', () => {
        // The merged network is re-outlined, so the shared edge lands ~2 cm off. Over 160 m of
        // road that is a 3 m² sliver — which must not become a parcel.
        const redrawn = box(15.880, 43.72999978, 15.882, 43.731);
        const sliver = grow.newGroundGeometry(redrawn, [existing], turf);
        expect(sliver).toBeNull();
        // Without the edge tolerance it WOULD be ground: the geometry really does differ.
        expect(areaOf(grow.newGroundGeometry(redrawn, [existing], turf, 0))).toBeGreaterThan(1);
    });
});

describe('planCorridorGrowth', () => {
    // The corridor's new ground: a strip across the middle of the eastern parcel.
    const newGround = box(15.8830, 43.7300, 15.8835, 43.7320);

    const straddling = { id: 'HR-1', geometry: box(15.8820, 43.7305, 15.8845, 43.7315) };
    const swallowed = { id: 'HR-2', geometry: box(15.88305, 43.73055, 15.88345, 43.73145) };
    const elsewhere = { id: 'HR-3', geometry: box(15.8700, 43.7200, 15.8710, 43.7210) };
    const abutting = { id: 'HR-4', geometry: box(15.8835, 43.7305, 15.8845, 43.7315) };

    it('cuts what the corridor takes ground from and reports the remainders', () => {
        const plan = grow.planCorridorGrowth({
            newGround,
            parcels: [straddling, swallowed, elsewhere, abutting],
            turf
        });
        const cut = plan.cuts.find(entry => entry.parcelId === 'HR-1');
        expect(cut).toBeTruthy();
        expect(cut.consumed).toBe(false);
        // Cut across the middle: the owner keeps a piece either side.
        expect(cut.remainders.length).toBe(2);
        const kept = cut.remainders.reduce((sum, piece) => sum + piece.area, 0);
        expect(kept + cut.takenArea).toBeCloseTo(areaOf(straddling.geometry), -1);
    });

    it('marks a parcel the corridor covers whole as consumed, with nothing left over', () => {
        const plan = grow.planCorridorGrowth({ newGround, parcels: [swallowed], turf });
        expect(plan.cuts).toHaveLength(1);
        expect(plan.cuts[0].consumed).toBe(true);
        expect(plan.cuts[0].remainders).toEqual([]);
    });

    it('does not involve parcels the new ground never reaches', () => {
        const plan = grow.planCorridorGrowth({ newGround, parcels: [elsewhere], turf });
        expect(plan.cuts).toEqual([]);
    });

    it('does not involve a parcel that merely abuts the new ground', () => {
        const plan = grow.planCorridorGrowth({ newGround, parcels: [abutting], turf });
        expect(plan.cuts).toEqual([]);
    });

    it('does not re-form a parcel over an overlap too small to be ground', () => {
        // Overlaps by ~1 cm of longitude over 1 m of latitude — float noise along a shared edge,
        // not a taking. Re-forming it would churn a parcel the drawing never really touched.
        const grazing = { id: 'HR-5', geometry: box(15.88349999, 43.7305, 15.8845, 43.7315) };
        expect(areaOf(turf.intersect(
            { type: 'Feature', properties: {}, geometry: grazing.geometry },
            { type: 'Feature', properties: {}, geometry: newGround }
        ).geometry)).toBeLessThan(1);
        expect(grow.planCorridorGrowth({ newGround, parcels: [grazing], turf }).cuts).toEqual([]);
    });

    it('turns the new ground into the corridor pieces to mint', () => {
        const plan = grow.planCorridorGrowth({ newGround, parcels: [straddling], turf });
        expect(plan.corridorPieces).toHaveLength(1);
        expect(plan.corridorPieces[0].area).toBeCloseTo(areaOf(newGround), -1);
    });

    it('mints one corridor parcel per disconnected piece of new ground', () => {
        const split = {
            type: 'MultiPolygon',
            coordinates: [box(15.8830, 43.7300, 15.8835, 43.7310).coordinates,
                box(15.8850, 43.7300, 15.8855, 43.7310).coordinates]
        };
        const plan = grow.planCorridorGrowth({ newGround: split, parcels: [], turf });
        expect(plan.corridorPieces).toHaveLength(2);
    });
});

describe('nextSyntheticIndexByRoot', () => {
    it('continues a grown road’s numbering instead of restarting it', () => {
        const next = grow.nextSyntheticIndexByRoot(
            ['HR-339270-823/1#p-abc-1', 'HR-339270-823/1#p-abc-4', 'HR-339270-6804/1#p-abc-2'],
            'p-abc'
        );
        expect(next['HR-339270-823/1']).toBe(5);
        expect(next['HR-339270-6804/1']).toBe(3);
    });

    it('ignores slices minted by other proposals', () => {
        const next = grow.nextSyntheticIndexByRoot(['HR-1#p-other-9'], 'p-abc');
        expect(next['HR-1']).toBeUndefined();
    });

    it('is empty for a road that has never minted anything', () => {
        expect(grow.nextSyntheticIndexByRoot([], 'p-abc')).toEqual({});
    });
});
