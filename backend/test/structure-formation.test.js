// Every park, square and lake follows one parcel-formation path; stations remain content on their
// corridor and therefore form no ground of their own.

import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';

const require = createRequire(import.meta.url);
const { structureNeedsGroundFormation, structureTakeContext } = require('../../frontend/js/proposals/apply/structures.js');
const formationEdit = require('../../frontend/js/proposals/formation-edit.js');
const parcelArrangement = require('../../frontend/js/proposals/parcel-arrangement.js');

function box(west, south, east, north, id = null) {
    return {
        type: 'Feature',
        properties: id ? { parcelId: id } : {},
        geometry: {
            type: 'Polygon',
            coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]]
        }
    };
}

describe('structure ground formation', () => {
    it('forms ground for every land-based structure kind', () => {
        expect(structureNeedsGroundFormation('park')).toBe(true);
        expect(structureNeedsGroundFormation('square')).toBe(true);
        expect(structureNeedsGroundFormation('lake')).toBe(true);
    });

    it('keeps stations content-only on their corridor', () => {
        expect(structureNeedsGroundFormation('station')).toBe(false);
    });

    it('measures a whole Sibenik block with the hardened fabric clipper', () => {
        const west = 15.873701234414993;
        const split = west + 0.001;
        const east = split + 0.001;
        const footprint = box(west, 43.754, east, 43.755);
        const candidates = [
            { id: 'west', feature: box(west, 43.754, split, 43.755, 'west') },
            { id: 'east', feature: box(split, 43.754, east, 43.755, 'east') }
        ];
        const fragileTurf = {
            ...turf,
            intersect: vi.fn(() => { throw new Error('Unable to complete output ring'); })
        };
        const clip = vi.fn((operation, left, right) => parcelArrangement.clip(operation, left, right));
        const priorTurf = globalThis.turf;
        globalThis.turf = turf;
        let plan;
        try {
            plan = formationEdit.wholeParcelTakePlan(
                footprint,
                candidates,
                structureTakeContext(fragileTurf, { clip })
            );
        } finally {
            if (priorTurf === undefined) delete globalThis.turf;
            else globalThis.turf = priorTurf;
        }

        expect(plan.mode).toBe('merge');
        expect(plan.uncoveredShare).toBeLessThan(0.000001);
        expect(clip).toHaveBeenCalled();
        expect(fragileTurf.intersect).not.toHaveBeenCalled();
    });
});
