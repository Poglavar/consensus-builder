// Geometry read out of the map must NOT be rounded. Leaflet's layer.toGeoJSON() defaults to 6
// decimal places (~8 cm of longitude, ~11 cm of latitude at Zagreb's latitude), and that rounding —
// not the boolean op — is what produced sliver overlaps between a corridor and the remainders it cut.
//
// Measured on the real Cibona fabric (2026-08-08), same cut four ways:
//   cut at 6 dp, result NOT rounded        -> 0 m2 overlap
//   cut at full precision, NOT rounded     -> 0 m2 overlap
//   cut at 6 dp, result rounded            -> 2.478 m2
//   cut at full precision, result rounded  -> 1.376 m2
// The cut is exact either way; rounding the RESULT is the whole defect. difference() interpolates
// new vertices where the cutter crosses a parcel edge, and those points have no twin vertex on the
// other polygon to round with, so rounding drifts them off the shared line.
//
// This suite fails on any bare `.toGeoJSON()` in the files that feed geometry, so the rounding
// cannot creep back in one call site at a time.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// Every file that reads geometry off a Leaflet layer. Adding a new one is fine — adding a bare
// toGeoJSON() to it is not.
const GEOMETRY_READERS = [
    'frontend/js/proposals/cadastre-ancestry.js',
    'frontend/js/proposals/layer-render.js',
    'frontend/js/proposals/plan-stats.js',
    'frontend/js/proposals/claims-ui.js',
    'frontend/js/proposals/core.js',
    'frontend/js/proposal-manager.js',
    'frontend/js/road-detection.js',
    'frontend/js/government-roads.js',
    'frontend/js/parcel-blocks.js',
    'frontend/js/parcels/ui/claim.js'
];

const read = rel => readFileSync(new URL('../../' + rel, import.meta.url), 'utf8');

describe('map geometry is read at full precision', () => {
    GEOMETRY_READERS.forEach(rel => {
        it(`${rel} never reads a layer with Leaflet's default rounding`, () => {
            const source = read(rel);
            // `.toGeoJSON()` with no argument takes Leaflet's 6-decimal default.
            const bare = source.match(/\.toGeoJSON\(\s*\)/g) || [];
            expect(bare, `${rel} has ${bare.length} rounded geometry read(s); pass false`).toEqual([]);
            // Keep this file on the list only while it really is a geometry reader. That guards
            // against deleting call sites without replacing the test's old magic global count.
            expect(source, `${rel} no longer reads Leaflet geometry`).toContain('.toGeoJSON(false)');
        });
    });

    it('states why the precision flag is load-bearing where the cut consumes it', () => {
        expect(read('frontend/js/proposals/cadastre-ancestry.js')).toContain('toGeoJSON(false)');
    });
});
