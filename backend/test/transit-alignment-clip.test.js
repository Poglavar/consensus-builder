// An applied corridor deletes the stretch of existing alignment it covers — but only when the two
// share the ground. A road drawn under the Zagreb heavy-rail viaduct was cutting gaps in a deck
// 7.5 m above it (two pedestrian routes at Cibona chopped the viaduct into pieces), because the
// clip mask was the plan-view footprint of every corridor regardless of height.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const TransitAlignments = require('../../frontend/js/transit-alignments.js');

const VIADUCT = { id: 'zagreb-heavy-rail', mode: 'heavy-rail', elevationM: 7.5, render3d: 'elevated' };
const TRAM = { id: 'zagreb-tram', mode: 'tram', elevationM: 0, render3d: 'surface' };
const ROAD = { isTrack: false };
const TRACK = { isTrack: true };

describe('existing alignment vs applied corridor', () => {
    it('reads a viaduct as elevated and a street tram as not', () => {
        expect(TransitAlignments.isElevatedSource(VIADUCT)).toBe(true);
        expect(TransitAlignments.isElevatedSource(TRAM)).toBe(false);
        // Height alone is enough: a source that stands above the street is elevated whatever its
        // renderer is called.
        expect(TransitAlignments.isElevatedSource({ render3d: 'surface', elevationM: 6 })).toBe(true);
        expect(TransitAlignments.isElevatedSource(null)).toBe(false);
    });

    it('lets a road pass under a viaduct instead of cutting it', () => {
        expect(TransitAlignments.corridorClipsSource(VIADUCT, ROAD)).toBe(false);
    });

    it('still lets a track corridor replace the line it is laid along', () => {
        expect(TransitAlignments.corridorClipsSource(VIADUCT, TRACK)).toBe(true);
    });

    it('keeps a surface tram yielding to anything built over it', () => {
        expect(TransitAlignments.corridorClipsSource(TRAM, ROAD)).toBe(true);
        expect(TransitAlignments.corridorClipsSource(TRAM, TRACK)).toBe(true);
    });

    it('treats an unknown corridor as a road — the case that must not delete a deck', () => {
        expect(TransitAlignments.corridorClipsSource(VIADUCT, null)).toBe(false);
        expect(TransitAlignments.corridorClipsSource(VIADUCT, {})).toBe(false);
    });
});
