// The government-plan layer must never ask /planned-road for a view the backend rejects: the
// client-side guard (frontend/js/view-bbox-limit.js) has to agree with the route's own limit and
// area formula, or users see "Failed to fetch planned roads (status 400)" instead of "zoom in".

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { MAX_VIEW_BBOX_KM2, wgs84BboxAreaKm2 } from '../utils/helpers.js';

const require = createRequire(import.meta.url);
const limit = require('../../frontend/js/view-bbox-limit.js');

describe('view-bbox-limit', () => {
    it('uses the backend limit', () => {
        expect(limit.MAX_VIEW_BBOX_KM2).toBe(MAX_VIEW_BBOX_KM2);
    });

    it('computes the same WGS84 area as the backend helper', () => {
        const box = [15.85, 45.75, 16.1, 45.88];
        expect(limit.wgs84BboxAreaKm2(...box)).toBeCloseTo(wgs84BboxAreaKm2(...box), 9);
    });

    it('measures an EPSG:3765 bbox string the way /planned-road does', () => {
        // 20 km × 20 km = exactly the limit — allowed; one metre more is not.
        const x0 = 450000, y0 = 5070000;
        const atLimit = `${x0},${y0},${x0 + 20000},${y0 + 20000}`;
        const over = `${x0},${y0},${x0 + 20001},${y0 + 20000}`;
        expect(limit.metricBboxAreaKm2(atLimit)).toBe(400);
        expect(limit.isViewTooLarge(limit.metricBboxAreaKm2(atLimit))).toBe(false);
        expect(limit.isViewTooLarge(limit.metricBboxAreaKm2(over))).toBe(true);
    });

    it('returns null for bboxes the backend would reject as invalid', () => {
        expect(limit.metricBboxAreaKm2('')).toBeNull();
        expect(limit.metricBboxAreaKm2('1,2,3')).toBeNull();
        expect(limit.metricBboxAreaKm2('5,5,1,1')).toBeNull();
        expect(limit.metricBboxAreaKm2('a,b,c,d')).toBeNull();
        expect(limit.isViewTooLarge(null)).toBe(false);
    });

    it('measures Leaflet-like bounds and rejects missing coordinates', () => {
        const bounds = (sw, ne) => ({ getSouthWest: () => sw, getNorthEast: () => ne });
        const b = bounds({ lat: 45.75, lng: 15.85 }, { lat: 45.88, lng: 16.1 });
        expect(limit.boundsAreaKm2(b)).toBeCloseTo(wgs84BboxAreaKm2(15.85, 45.75, 16.1, 45.88), 9);
        expect(limit.boundsAreaKm2(bounds({ lat: null, lng: 15.85 }, { lat: 45.88, lng: 16.1 }))).toBeNull();
    });
});
