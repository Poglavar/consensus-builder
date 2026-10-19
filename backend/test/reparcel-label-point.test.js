// Plot number placement in the land readjustment designer: the clearest spot of the plot, away from
// edges and nodes first, off guide lines (old parcels, building outlines) second.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { labelPoint } = require('../../frontend/js/reparcel-label-point.js');

// Local metres around a mid-latitude origin, so expectations read in metres.
const LAT0 = 45.8, LNG0 = 15.97, COS = Math.cos(LAT0 * Math.PI / 180);
const ll = ([x, y]) => [LNG0 + x / (111320 * COS), LAT0 + y / 110540];
const xy = ([lng, lat]) => [(lng - LNG0) * 111320 * COS, (lat - LAT0) * 110540];
const polygon = (...rings) => ({ type: 'Polygon', coordinates: rings.map(ring => [...ring, ring[0]].map(ll)) });
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const at = (geometry, options) => xy(labelPoint(geometry, options));
const close = (value, target, tolerance) => expect(Math.abs(value - target)).toBeLessThan(tolerance);

describe('labelPoint', () => {
    it('puts a square plot’s number in its middle', () => {
        const [x, y] = at(polygon(rect(0, 0, 40, 40)), { radiusM: 2 });
        close(x, 20, 1); close(y, 20, 1);
    });

    it('keeps an L-shaped plot’s number inside, in the thicker part, clear of the inner corner', () => {
        // An L whose centroid falls in the notch: the old centroid rule had to fall back to any point.
        const L = polygon([[0, 0], [40, 0], [40, 10], [10, 10], [10, 40], [0, 40]]);
        const [x, y] = at(L, { radiusM: 2 });
        expect(x > 0 && x < 40 && y > 0 && y < 40).toBe(true);
        expect(x < 10 || y < 10).toBe(true);
        // At least 3 m from every edge: it is not squeezed against a border or the inner node.
        expect(Math.min(x, y, 40 - x, Math.abs(10 - Math.max(x, y)))).toBeGreaterThan(3);
    });

    it('centres a thin strip’s number along its length and across its width', () => {
        const [x, y] = at(polygon(rect(0, 0, 100, 6)), { radiusM: 2 });
        close(y, 3, 0.3); close(x, 50, 5);
    });

    it('steps off a guide line crossing the plot when there is room', () => {
        // An old parcel boundary runs straight through the middle of the plot.
        const old = polygon(rect(-10, -10, 20, 50));
        const [x] = at(polygon(rect(0, 0, 40, 40)), { radiusM: 2, guides: [old] });
        expect(Math.abs(x - 20)).toBeGreaterThan(1.9);
    });

    it('moves away from a node in the middle of a long edge', () => {
        // A short plot with an extra node (a T-junction) at the middle of its top edge.
        const plot = polygon([[0, 0], [30, 0], [30, 8], [15, 8], [0, 8]]);
        const [x, y] = at(plot, { radiusM: 2 });
        expect(Math.hypot(x - 15, y - 8)).toBeGreaterThan(4);
        close(y, 4, 0.5);
    });

    it('chooses the roomier piece of a multipolygon plot', () => {
        const geometry = { type: 'MultiPolygon', coordinates: [polygon(rect(0, 0, 4, 4)).coordinates, polygon(rect(20, 0, 50, 30)).coordinates] };
        const [x, y] = at(geometry, { radiusM: 2 });
        close(x, 35, 2); close(y, 15, 2);
    });

    it('avoids a courtyard hole', () => {
        const [x, y] = at(polygon(rect(0, 0, 40, 40), rect(10, 10, 30, 30)), { radiusM: 1 });
        const inHole = x > 10 && x < 30 && y > 10 && y < 30;
        expect(inHole).toBe(false);
    });

    it('returns null for an empty geometry', () => {
        expect(labelPoint(null)).toBe(null);
        expect(labelPoint({ type: 'Polygon', coordinates: [] })).toBe(null);
    });
});
