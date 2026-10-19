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
// Geometry-producing code now reads domain GeoJSON directly from LiveParcelFabric or the
// cadastral repository. Leaflet is a write-only projection, so any `.toGeoJSON()` in these files
// is an architectural regression rather than merely a precision bug.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const DOMAIN_GEOMETRY_READERS = [
    'frontend/js/road-detection.js',
    'frontend/js/parcel-blocks.js',
    'frontend/js/proposals/core.js',
    'frontend/js/government-roads.js',
    'frontend/js/parcels/ui/claim.js',
    'frontend/js/proposals/layer-render.js',
    'frontend/js/proposals/plan-stats.js',
    'frontend/js/proposals/cadastre-ancestry.js',
    'frontend/js/proposals/claims-ui.js',
    'frontend/js/proposal-manager.js'
];

const read = rel => readFileSync(new URL('../../' + rel, import.meta.url), 'utf8');

describe('map geometry is read at full precision', () => {
    DOMAIN_GEOMETRY_READERS.forEach(rel => {
        it(`${rel} reads domain GeoJSON rather than serialising Leaflet`, () => {
            const source = read(rel);
            expect(source).not.toContain('.toGeoJSON(');
            expect(source).toMatch(/LiveParcelFabric|CadastralParcelRepository/);
        });
    });
});
