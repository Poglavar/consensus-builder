// The outline of selected parcels (proposals/geometry.js buildGeometryFromParcels) keeps a gap between
// them as a hole only when the gap is ground: debris along shared edges that do not quite meet is not.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Evaluated in THIS realm, where turf's own classes live (a vm realm no-ops turf).
const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
globalThis.turf = turf;
const src = readFileSync(fileURLToPath(new URL('../../frontend/js/proposals/geometry.js', import.meta.url)), 'utf8');
const body = src.slice(src.indexOf('function buildGeometryFromParcels('), src.indexOf('function computeLakeZonesForGeometry('));
const apis = src.slice(src.indexOf('function proposalGeometryClipApi('), src.indexOf('function getFeatureCentroid('));
const build = (0, eval)(`(function (window) { ${apis}\nreturn (${body}); })`)({ // eslint-disable-line no-eval
    __parcelArrangement: require('../../frontend/js/proposals/parcel-arrangement.js'),
    GeometryTolerances: require('../../frontend/js/geometry-tolerances.js'),
});

const D = 1e-5; // about 1.1 m at this latitude
const at = ([x, y]) => [-74.067 + x * D, 4.632 + y * D];
const lot = points => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[...points, points[0]].map(at)] } });
const holes = geometry => geometry.coordinates.flatMap(rings => rings.slice(1));

describe('buildGeometryFromParcels holes', () => {
    it('drops the debris between lots whose shared edge does not quite meet', () => {
        // B's edge leaves A's for its middle part, 0.2 mm away: a sliver enclosed by the two lots.
        const a = lot([[0, 0], [10, 0], [10, 20], [0, 20]]);
        const off = 10 + 2e-4 / 1.1;
        const b = lot([[10, 0], [20, 0], [20, 20], [10, 20], [10, 15], [off, 12], [off, 8], [10, 5]]);
        const pool = build([a, b]);
        expect(pool.coordinates).toHaveLength(1);
        expect(holes(pool)).toHaveLength(0);
    });

    it('keeps a courtyard no selected lot covers as a hole', () => {
        // Four lots round a 6 × 6 unit (about 6.6 m) courtyard.
        const lots = [
            lot([[0, 0], [20, 0], [20, 7], [0, 7]]),
            lot([[0, 13], [20, 13], [20, 20], [0, 20]]),
            lot([[0, 7], [7, 7], [7, 13], [0, 13]]),
            lot([[13, 7], [20, 7], [20, 13], [13, 13]]),
        ];
        const pool = build(lots);
        expect(holes(pool)).toHaveLength(1);
        expect(turf.area(turf.polygon([holes(pool)[0]]))).toBeGreaterThan(40);
    });
});
