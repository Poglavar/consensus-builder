// The legacy-centreline flag migration (scripts/flag-legacy-centreline-roads.mjs): it flags exactly
// the road records the footprint reader would refuse as unprepared corridors, in both copies of the
// sub-proposal, leaves everything else alone, and --restore undoes exactly what it added.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { needsLegacyFlag, rowUpdate, parseArgs, LEGACY_FRAME } from '../scripts/flag-legacy-centreline-roads.mjs';

const require = createRequire(import.meta.url);
const { footprintParts } = require('../../frontend/js/proposals/footprint-parts.js');

const points = [{ lat: 45.8, lng: 15.97 }, { lat: 45.801, lng: 15.971 }];
const square = { type: 'Polygon', coordinates: [[[15.97, 45.8], [15.971, 45.8], [15.971, 45.801], [15.97, 45.8]]] };

describe('needsLegacyFlag', () => {
    it('is true exactly for a centre line stored without land and without a frame', () => {
        expect(needsLegacyFlag({ width: 8, points })).toBe(true);
        expect(needsLegacyFlag({ width: 8, points, polygon: null, latLngPairs: null })).toBe(true);
        expect(needsLegacyFlag({ width: 8, points, polygon: square })).toBe(false);
        expect(needsLegacyFlag({ width: 8, points, constructionFrame: { kind: 'local-tmerc' } })).toBe(false);
        expect(needsLegacyFlag({ width: 8, points, constructionFrame: LEGACY_FRAME })).toBe(false);
        expect(needsLegacyFlag({ polygon: square })).toBe(false); // a designation of whole parcels
        expect(needsLegacyFlag(null)).toBe(false);
    });
});

describe('rowUpdate', () => {
    const row = (column, data) => ({ id: 7, road_proposal: column, data_road: data });

    it('flags both copies, after which the footprint is the approximate legacy centreline', () => {
        const update = rowUpdate(row({ definition: { width: 8, points }, applied: true }, { definition: { width: 8, points, polygon: null } }));
        expect(update.roadProposal.definition.constructionFrame).toEqual(LEGACY_FRAME);
        expect(update.roadProposal.applied).toBe(true);
        expect(update.dataRoad.definition.constructionFrame).toEqual(LEGACY_FRAME);
        const parts = footprintParts({ roadProposal: update.roadProposal });
        expect(parts.invalid).toBeNull();
        expect(parts.approximate).toBe(true);
        expect(parts.centerline.halfWidthM).toBe(4);
    });

    it('leaves a copy that has land, and a row with nothing to do', () => {
        const update = rowUpdate(row({ definition: { width: 8, points, polygon: square } }, { definition: { width: 8, points } }));
        expect(update.roadProposal).toBeNull();
        expect(update.dataRoad.definition.constructionFrame).toEqual(LEGACY_FRAME);
        expect(rowUpdate(row({ definition: { width: 8, points, polygon: square } }, null))).toBeNull();
    });

    it('restore removes exactly the flags it added, and is the inverse of apply', () => {
        const original = row({ definition: { width: 8, points } }, { definition: { width: 8, points } });
        const flagged = rowUpdate(original);
        const restored = rowUpdate({ id: 7, road_proposal: flagged.roadProposal, data_road: flagged.dataRoad }, 'restore');
        expect(restored.roadProposal).toEqual(original.road_proposal);
        expect(restored.dataRoad).toEqual(original.data_road);
        // a frame someone else set is never touched
        expect(rowUpdate(row({ definition: { width: 8, points, constructionFrame: { kind: 'legacy-centreline' } } }, null), 'restore')).toBeNull();
    });
});

describe('parseArgs', () => {
    it('defaults to a dry run and refuses contradictory modes', () => {
        expect(parseArgs([])).toMatchObject({ apply: false, restore: false, ids: null });
        expect(parseArgs(['--ids', '2,3'])).toMatchObject({ ids: [2, 3] });
        expect(() => parseArgs(['--apply', '--restore'])).toThrow(/either/);
        expect(() => parseArgs(['--bogus'])).toThrow(/Unknown/);
    });
});
