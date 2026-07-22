// Unit tests for frontend/js/area-monitor/monitor-buildings.js — clipping building footprints to a
// monitored area before counting. turf is set on the global in THIS realm for cross-boundary instanceof.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';

globalThis.turf = turf;

const require = createRequire(import.meta.url);
const { countBuildingsInPolygon } = require('../../frontend/js/area-monitor/monitor-buildings.js');

function squareFeature(west, south, side) {
    return turf.polygon([[
        [west, south], [west + side, south], [west + side, south + side], [west, south + side], [west, south]
    ]]);
}

// Monitor ~200 m square around Zagreb.
const MONITOR = squareFeature(15.97, 45.81, 0.0018).geometry;
const INSIDE_A = squareFeature(15.9705, 45.8105, 0.0002);
const INSIDE_B = squareFeature(15.9712, 45.8112, 0.0002);
const OUTSIDE = squareFeature(15.99, 45.83, 0.0002); // well clear of the monitor

describe('countBuildingsInPolygon', () => {
    it('counts only footprints inside the monitor polygon', () => {
        const fc = turf.featureCollection([INSIDE_A, INSIDE_B, OUTSIDE]);
        const result = countBuildingsInPolygon(fc, MONITOR);
        expect(result.count).toBe(2);
        expect(result.features).toHaveLength(2);
    });

    it('accepts a bare feature array', () => {
        const result = countBuildingsInPolygon([INSIDE_A, OUTSIDE], MONITOR);
        expect(result.count).toBe(1);
    });

    it('accepts a Feature-wrapped polygon as well as a bare geometry', () => {
        const fc = turf.featureCollection([INSIDE_A, OUTSIDE]);
        expect(countBuildingsInPolygon(fc, squareFeature(15.97, 45.81, 0.0018)).count).toBe(1);
    });

    it('passes everything through (no clip) when no polygon is given', () => {
        const fc = turf.featureCollection([INSIDE_A, OUTSIDE]);
        expect(countBuildingsInPolygon(fc, null).count).toBe(2);
    });

    it('returns zero for empty input', () => {
        expect(countBuildingsInPolygon(null, MONITOR)).toEqual({ count: 0, features: [] });
        expect(countBuildingsInPolygon({ features: [] }, MONITOR).count).toBe(0);
    });
});
