// Purpose: headless coverage for the parcel-layout editor's plan utilities: carving a polygon into a
// layout (exact conservation, no overlap, provenance) and finding building-block courtyards.
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
    it('carves a courtyard from adjacent plots with exact conservation and no overlap', () => {
        const left = square(0, 0, 2, 4);
        const right = square(2, 0, 4, 4);
        const slices = [
            { geometry: left.geometry, source: 'amend' },
            { geometry: right.geometry, source: 'amend' }
        ];
        const courtyard = square(1.5, 1, 2.5, 3);
        const before = slices.reduce((sum, slice) => sum + area(slice.geometry), 0);
        const next = utils.carveLayout({ pool: turf.union(left, right), slices, polygon: courtyard.geometry, source: 'form' }, turf);

        expect(next.filter(slice => slice.source === 'form')).toHaveLength(1);
        expect(next.filter(slice => slice.source === 'amend')).toHaveLength(2);
        expect(next.reduce((sum, slice) => sum + area(slice.geometry), 0)).toBeCloseTo(before, 6);
        for (let i = 0; i < next.length; i++) for (let j = i + 1; j < next.length; j++) {
            const overlap = turf.intersect(turf.feature(next[i].geometry), turf.feature(next[j].geometry));
            expect(overlap ? turf.area(overlap) : 0).toBeLessThan(1e-8);
        }
        // Geometry only: the carved plot is its shape and how it was made.
        expect(Object.keys(next.find(slice => slice.source === 'form')).sort()).toEqual(['geometry', 'source']);
    });

    it('copies new derivation provenance while preserving each retained slice provenance', () => {
        const left = square(0, 0, 2, 4);
        const right = square(2, 0, 4, 4);
        const slices = [
            { geometry: left.geometry, source: 'amend', derivation: { kind: 'existing', sourceTitle: 'old-a' } },
            { geometry: right.geometry, source: 'amend', derivation: { kind: 'existing', sourceTitle: 'old-b' } }
        ];
        const derivation = { kind: 'building-courtyard', sourceTitle: 'Block', sourceFootprint: left.geometry };
        const next = utils.carveLayout({ pool: turf.union(left, right), slices, polygon: square(1.5, 1, 2.5, 3).geometry,
            source: 'form', derivation }, turf);

        expect(next.find(slice => slice.source === 'form').derivation).toEqual(derivation);
        expect(next.filter(slice => slice.source === 'amend').map(slice => slice.derivation))
            .toEqual(slices.map(slice => slice.derivation));
        next.find(slice => slice.source === 'form').derivation.sourceFootprint.coordinates[0][0][0] = 99;
        expect(derivation.sourceFootprint).toEqual(left.geometry);
        expect(slices.map(slice => slice.derivation.sourceTitle)).toEqual(['old-a', 'old-b']);
    });

    it('keeps a positive sub-square-metre remainder', () => {
        const parcel = square(0, 0, 0.001, 0.001);
        const cut = square(0, 0, 0.0009999999, 0.001);
        const next = utils.carveLayout({ pool: parcel, slices: [{ geometry: parcel.geometry, source: 'base' }],
            polygon: cut.geometry, source: 'manual' }, turf);
        expect(next.some(slice => slice.source === 'base' && area(slice.geometry) > 0 && area(slice.geometry) < 1)).toBe(true);
    });

    it('answers null for a polygon that does not reach the pool', () => {
        const pool = square(0, 0, 0.001, 0.001);
        expect(utils.carveLayout({ pool, slices: [{ geometry: pool.geometry, source: 'base' }],
            polygon: square(1, 1, 1.001, 1.001).geometry, source: 'manual' }, turf)).toBeNull();
    });

    it('leaves originals untouched when difference throws', () => {
        const parcel = square(0, 0, 1, 1);
        const slices = [{ geometry: parcel.geometry, source: 'base' }];
        const throwingTurf = { ...turf, difference: () => { throw new Error('boom'); } };
        expect(() => utils.carveLayout({ pool: parcel, slices, polygon: parcel.geometry, source: 'x' }, throwingTurf)).toThrow('boom');
        expect(slices[0].geometry).toEqual(parcel.geometry);
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
            { applied: false, proposalId: 'block-proposal', title: 'Block title', buildingProposal: {}, geometry: { blockMassing: turf.feature(block.geometry), buildings: [{ geometry: square(20, 20, 24, 24).geometry }, { geometry: square(24, 20, 28, 28).geometry }] } },
            { applied: false, buildingProposal: { blockGeometry: noHole.geometry }, geometry: { buildings: [{ geometry: noHole.geometry }] } },
            { applied: false, geometry: { buildings: [{ geometry: remote.geometry }] } }
        ], pool, turf);
        expect(candidates).toHaveLength(1);
        expect(candidates[0].proposal.geometry.blockMassing.geometry).toEqual(block.geometry);
        // A design never depends on another design: the derivation names the block, it does not point at it.
        expect(candidates[0].derivation).toEqual({
            kind: 'building-courtyard', sourceTitle: 'Block title', sourceFootprint: block.geometry
        });
    });

    it('snapshots building source title and footprint independently of later edits', () => {
        const pool = square(0, 0, 10, 10);
        const footprint = turf.polygon([[[20, 20], [28, 20], [28, 28], [20, 28], [20, 20]], [[3, 3], [3, 7], [7, 7], [7, 3], [3, 3]]]);
        const proposal = { proposalId: 'building-7', title: 'Original title', buildingProposal: {},
            geometry: { blockMassing: turf.feature(footprint.geometry) } };
        const candidate = utils.buildingCourtyardCandidates([proposal], pool, turf)[0];
        const originalFootprint = JSON.parse(JSON.stringify(footprint.geometry));
        proposal.title = 'Edited title';
        proposal.geometry.blockMassing.geometry.coordinates[0][0][0] = 99;

        expect(candidate.derivation).toEqual({
            kind: 'building-courtyard', sourceTitle: 'Original title', sourceFootprint: originalFootprint
        });
    });
});
