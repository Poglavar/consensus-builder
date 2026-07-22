// Unit tests for frontend/js/road-snap-legacy.js — converting the existing-road GeoJSON into snap
// segments for the road-drawing tool.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { geojsonToSnapSegments } = require('../../frontend/js/road-snap-legacy.js');

describe('geojsonToSnapSegments', () => {
    it('converts LineString features to {lat,lng} segments', () => {
        const fc = {
            type: 'FeatureCollection',
            features: [
                { type: 'Feature', geometry: { type: 'LineString', coordinates: [[15.97, 45.81], [15.98, 45.82]] } }
            ]
        };
        const out = geojsonToSnapSegments(fc);
        expect(out).toHaveLength(1);
        expect(out[0]).toEqual({ segment: [{ lat: 45.81, lng: 15.97 }, { lat: 45.82, lng: 15.98 }], legacy: true });
    });

    it('splits a MultiLineString into one entry per part', () => {
        const fc = { features: [
            { geometry: { type: 'MultiLineString', coordinates: [
                [[15.97, 45.81], [15.98, 45.81]],
                [[16.0, 45.8], [16.01, 45.8]]
            ] } }
        ] };
        expect(geojsonToSnapSegments(fc)).toHaveLength(2);
    });

    it('drops degenerate lines (fewer than two valid points)', () => {
        const fc = { features: [
            { geometry: { type: 'LineString', coordinates: [[15.97, 45.81]] } },
            { geometry: { type: 'LineString', coordinates: [['x', 'y'], [15.98, 45.82]] } }
        ] };
        expect(geojsonToSnapSegments(fc)).toEqual([]);
    });

    it('accepts a bare feature array and ignores non-line geometry', () => {
        const features = [
            { geometry: { type: 'Point', coordinates: [15.97, 45.81] } },
            { geometry: { type: 'LineString', coordinates: [[15.9, 45.8], [15.91, 45.8]] } }
        ];
        expect(geojsonToSnapSegments(features)).toHaveLength(1);
    });

    it('returns [] for junk input', () => {
        expect(geojsonToSnapSegments(null)).toEqual([]);
        expect(geojsonToSnapSegments({})).toEqual([]);
        expect(geojsonToSnapSegments(42)).toEqual([]);
    });
});
