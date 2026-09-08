// Purpose: headless coverage for reparcellization layout, courtyard, ownership, and agreement splitting utilities.
import { describe, expect, it } from 'vitest';
import * as turf from '@turf/turf';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const utils = require('../../frontend/js/reparcellization-plan-utils.js');

const square = (x1, y1, x2, y2) => turf.polygon([[
    [x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]
]]);
const area = geometry => turf.area(turf.feature(geometry));

describe('reparcellization plan utilities', () => {
    it('preserves existing parcel plots, ownership fractions, and input immutability', () => {
        const parcel = square(0, 0, 1, 1);
        const owners = [{ ownerKey: 'a', share: 0.75 }, { ownerKey: 'b', share: 0.25 }];
        const input = [{ properties: { parcelId: 'p1' }, geometry: parcel.geometry }];
        const result = utils.existingParcelPlots(input, new Map([['p1', owners]]));

        expect(result).toEqual([{ geometry: parcel.geometry, owners, source: 'amend', jointPool: false }]);
        result[0].owners[0].share = 0;
        result[0].geometry.coordinates[0][0][0] = 99;
        expect(input[0].geometry).toEqual(parcel.geometry);
        expect(owners[0].share).toBe(0.75);
    });

    it('carves a courtyard from adjacent parcels with exact conservation and no overlap', () => {
        const left = square(0, 0, 2, 4);
        const right = square(2, 0, 4, 4);
        const slices = [
            { geometry: left.geometry, owners: [{ ownerKey: 'a', share: 1 }] },
            { geometry: right.geometry, owners: [{ ownerKey: 'b', share: 1 }] }
        ];
        const courtyard = square(1.5, 1, 2.5, 3);
        const before = slices.reduce((sum, slice) => sum + area(slice.geometry), 0);
        const next = utils.carveLayout({ pool: turf.union(left, right), slices, polygon: courtyard.geometry,
            owners: [{ ownerKey: 'a', share: 0.5 }, { ownerKey: 'b', share: 0.5 }],
            source: 'courtyard', jointPool: true }, turf);

        expect(next.filter(slice => slice.jointPool)).toHaveLength(1);
        expect(next.reduce((sum, slice) => sum + area(slice.geometry), 0)).toBeCloseTo(before, 6);
        expect(next.filter(slice => !slice.jointPool)).toHaveLength(2);
        for (let i = 0; i < next.length; i++) for (let j = i + 1; j < next.length; j++) {
            const overlap = turf.intersect(turf.feature(next[i].geometry), turf.feature(next[j].geometry));
            expect(overlap ? turf.area(overlap) : 0).toBeLessThan(1e-8);
        }
    });

    it('keeps a positive sub-square-metre remainder', () => {
        const parcel = square(0, 0, 0.001, 0.001);
        const cut = square(0, 0, 0.0009999999, 0.001);
        const next = utils.carveLayout({ pool: parcel, slices: [{ geometry: parcel.geometry, owners: [] }],
            polygon: cut.geometry, owners: [], source: 'courtyard', jointPool: true }, turf);
        expect(next.some(slice => !slice.jointPool && area(slice.geometry) > 0 && area(slice.geometry) < 1)).toBe(true);
    });

    it('leaves originals untouched when difference throws', () => {
        const parcel = square(0, 0, 1, 1);
        const slices = [{ geometry: parcel.geometry, owners: [{ ownerKey: 'a', share: 1 }] }];
        const throwingTurf = { ...turf, difference: () => { throw new Error('boom'); } };
        expect(() => utils.carveLayout({ pool: parcel, slices, polygon: parcel.geometry, owners: [], source: 'x' }, throwingTurf)).toThrow('boom');
        expect(slices[0].geometry).toEqual(parcel.geometry);
    });

    it('weights joint courtyard shares by private slices and omits zero allocations', () => {
        const recipients = [{ ownerKey: 'a', name: 'A' }, { ownerKey: 'b', name: 'B' }, { ownerKey: 'z', name: 'Z' }];
        const slices = [
            { geometry: square(0, 0, 2, 1).geometry, owners: [{ ownerKey: 'a', share: 1 }] },
            { geometry: square(2, 0, 3, 1).geometry, owners: [{ ownerKey: 'b', share: 1 }] },
            { geometry: square(3, 0, 5, 1).geometry, jointPool: true, owners: [{ ownerKey: 'z', share: 1 }] }
        ];
        const shares = utils.jointOwnersForLayout(recipients, slices, turf);
        expect(shares.map(entry => entry.ownerKey)).toEqual(['a', 'b']);
        expect(shares[0].share).toBeCloseTo(2 / 3, 6);
        expect(shares[1].share).toBeCloseTo(1 / 3, 6);
        slices[1].owners[0].share = 0;
        expect(utils.jointOwnersForLayout(recipients, slices, turf).map(entry => entry.ownerKey)).toEqual(['a']);
    });

    it('uses equal shares when every recipient has zero private allocation', () => {
        expect(utils.computeJointProRataShares([{ ownerKey: 'a', weight: 0 }, { ownerKey: 'b', weight: 0 }]))
            .toEqual([{ ownerKey: 'a', share: 0.5 }, { ownerKey: 'b', share: 0.5 }]);
    });

    it('derives courtyard polygons, multipolygons, and holes without inventing a courtyard', () => {
        const polygon = turf.polygon([[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]], [[1, 1], [1, 2], [2, 2], [2, 1], [1, 1]]]);
        const multi = turf.multiPolygon([
            [[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]], [[1, 1], [1, 2], [2, 2], [2, 1], [1, 1]]],
            [[[5, 0], [9, 0], [9, 4], [5, 4], [5, 0]], [[6, 1], [6, 2], [7, 2], [7, 1], [6, 1]]]
        ]);
        expect(utils.deriveCourtyardFromFootprint(polygon).geometry.type).toBe('Polygon');
        expect(utils.deriveCourtyardFromFootprint(multi).geometry.type).toBe('MultiPolygon');
        expect(utils.deriveCourtyardFromFootprint(square(0, 0, 1, 1))).toBeNull();
        expect(utils.deriveCourtyardFromFootprint(turf.polygon([[[0, 0], [1, 0], [1, 1], [0, 0]]]))).toBeNull();
    });

    it('finds unapplied authored building blocks by canonical geometry.buildings footprints', () => {
        const pool = square(0, 0, 10, 10);
        const block = turf.polygon([[[20, 20], [28, 20], [28, 28], [20, 28], [20, 20]], [[3, 3], [3, 7], [7, 7], [7, 3], [3, 3]]]);
        const remote = square(20, 20, 22, 22);
        const noHole = square(3, 3, 4, 4);
        const candidates = utils.buildingCourtyardCandidates([
            { applied: false, buildingProposal: {}, geometry: { blockMassing: turf.feature(block.geometry), buildings: [{ geometry: square(20, 20, 24, 24).geometry }, { geometry: square(24, 20, 28, 28).geometry }] } },
            { applied: false, buildingProposal: { blockGeometry: noHole.geometry }, geometry: { buildings: [{ geometry: noHole.geometry }] } },
            { applied: false, geometry: { buildings: [{ geometry: remote.geometry }] } }
        ], pool, turf);
        expect(candidates).toHaveLength(1);
        expect(candidates[0].proposal.geometry.blockMassing.geometry).toEqual(block.geometry);
    });

    it('splits a courtyard plan into per-parcel mini plans without changing ownership', () => {
        const left = square(0, 0, 2, 2);
        const right = square(2, 0, 4, 2);
        const courtyard = square(1.5, 0.5, 2.5, 1.5);
        const plan = {
            inputParcels: [
                { parcelId: 'p1', geometry: left.geometry, owners: [{ ownerKey: 'a', share: 1 }] },
                { parcelId: 'p2', geometry: right.geometry, owners: [{ ownerKey: 'b', share: 1 }] }
            ],
            polygons: [
                { geometry: turf.difference(left, courtyard).geometry, owners: [{ ownerKey: 'a', share: 1 }] },
                { geometry: turf.difference(right, courtyard).geometry, owners: [{ ownerKey: 'b', share: 1 }] },
                { geometry: courtyard.geometry, jointPool: true, owners: [{ ownerKey: 'a', share: 0.5 }, { ownerKey: 'b', share: 0.5 }] }
            ]
        };
        const before = plan.inputParcels.map(parcel => area(parcel.geometry));
        const result = utils.splitPlanPerParcel(plan, turf);
        expect(result).toHaveLength(2);
        result.forEach((mini, index) => {
            expect(mini.polygons.filter(plot => plot.jointPool)).toHaveLength(1);
            expect(mini.polygons.filter(plot => !plot.jointPool).every(plot =>
                plot.owners[0].ownerKey === plan.inputParcels[index].owners[0].ownerKey)).toBe(true);
            expect(mini.polygons.reduce((sum, plot) => sum + plot.area, 0)).toBeCloseTo(before[index], 3);
        });
        expect(plan.inputParcels[0].geometry).toEqual(left.geometry);
        expect(plan.polygons[2].geometry).toEqual(courtyard.geometry);
    });

    it('rejects private transfers and fully consumed parcels', () => {
        const parcel = square(0, 0, 2, 2);
        const base = { inputParcels: [{ parcelId: 'p', geometry: parcel.geometry, owners: [{ ownerKey: 'a', share: 1 }] }] };
        expect(() => utils.splitPlanPerParcel({ ...base, polygons: [
            { geometry: square(0, 0, 1, 1).geometry, owners: [{ ownerKey: 'b', share: 1 }] },
            { geometry: square(0, 0, 2, 2).geometry, jointPool: true, owners: [] }
        ] }, turf)).toThrowError(expect.objectContaining({ code: 'private-transfer' }));
        expect(() => utils.splitPlanPerParcel({ ...base, polygons: [
            { geometry: parcel.geometry, jointPool: true, owners: [] }
        ] }, turf)).toThrowError(expect.objectContaining({ code: 'private-transfer' }));
    });

    it('retains an original input outside the courtyard with every private split', () => {
        const first = square(0, 0, 2, 2);
        const second = square(2, 0, 4, 2);
        const third = square(10, 0, 14, 4);
        const courtyard = square(1.5, 0.5, 2.5, 1.5);
        const ownerA = [{ ownerKey: 'a', share: 1 }];
        const ownerB = [{ ownerKey: 'b', share: 1 }];
        const ownerC = [{ ownerKey: 'c', share: 1 }];
        const plan = {
            inputParcels: [
                { label: 'A', geometry: first.geometry, owners: ownerA },
                { label: 'B', geometry: second.geometry, owners: ownerB },
                { label: 'C', geometry: third.geometry, owners: ownerC }
            ],
            polygons: [
                { geometry: turf.difference(first, courtyard).geometry, owners: ownerA },
                { geometry: turf.difference(second, courtyard).geometry, owners: ownerB },
                { geometry: square(10, 0, 12, 4).geometry, owners: ownerC },
                { geometry: square(12, 0, 14, 4).geometry, owners: ownerC },
                { geometry: courtyard.geometry, jointPool: true, owners: [{ ownerKey: 'a', share: 0.5 }, { ownerKey: 'b', share: 0.5 }] }
            ]
        };
        const result = utils.splitPlanPerParcel(plan, turf);
        expect(result).toHaveLength(3);
        const retained = result.find(part => part.input.label === 'C');
        expect(retained.polygons).toHaveLength(2);
        expect(retained.polygons.reduce((sum, plot) => sum + plot.area, 0)).toBeCloseTo(turf.area(third), 3);
        expect(retained.polygons.reduce((sum, plot) => sum + plot.percent, 0)).toBeCloseTo(100, 6);
        expect(plan.inputParcels[2].geometry).toEqual(third.geometry);
    });
});
