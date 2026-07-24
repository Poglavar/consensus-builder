// Unit tests for the pure parts of the OSM buildings reference layer: the Overpass `out geom;`
// element → GeoJSON conversion, the height tag reading, and the bbox query builder. No network.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { overpassElementsToGeoJSON, buildOverpassQuery, osmHeightMeters } = require('../buildings/osm-reference.js');

// A square way (open — first != last) with a building tag, as Overpass returns it with `out geom;`.
const wayEl = (id, tags = { building: 'yes' }) => ({
    type: 'way',
    id,
    tags,
    geometry: [
        { lat: 45.80, lon: 15.90 },
        { lat: 45.80, lon: 15.91 },
        { lat: 45.81, lon: 15.91 },
        { lat: 45.81, lon: 15.90 }
    ]
});

describe('overpassElementsToGeoJSON', () => {
    it('turns a building way into a closed Polygon feature keyed by OSM id', () => {
        const fc = overpassElementsToGeoJSON([wayEl(123)]);
        expect(fc.features).toHaveLength(1);
        const f = fc.features[0];
        expect(f.id).toBe('w123');
        expect(f.geometry.type).toBe('Polygon');
        const ring = f.geometry.coordinates[0];
        // GeoJSON is [lon, lat], and the ring is closed (first === last).
        expect(ring[0]).toEqual([15.90, 45.80]);
        expect(ring[ring.length - 1]).toEqual(ring[0]);
        expect(ring).toHaveLength(5);
    });

    it('builds a MultiPolygon from a relation\'s OUTER members and ignores inner courtyards', () => {
        const rel = {
            type: 'relation',
            id: 7,
            tags: { building: 'yes', type: 'multipolygon' },
            members: [
                { type: 'way', role: 'outer', geometry: [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 1, lon: 1 }] },
                { type: 'way', role: 'inner', geometry: [{ lat: 0.2, lon: 0.2 }, { lat: 0.2, lon: 0.3 }, { lat: 0.3, lon: 0.3 }] }
            ]
        };
        const fc = overpassElementsToGeoJSON([rel]);
        expect(fc.features).toHaveLength(1);
        expect(fc.features[0].id).toBe('r7');
        expect(fc.features[0].geometry.type).toBe('MultiPolygon');
        expect(fc.features[0].geometry.coordinates).toHaveLength(1); // only the outer ring
    });

    it('skips non-building elements and degenerate rings', () => {
        const notBuilding = { type: 'way', id: 1, tags: { highway: 'residential' }, geometry: wayEl(1).geometry };
        const twoPoint = { type: 'way', id: 2, tags: { building: 'yes' }, geometry: [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }] };
        const fc = overpassElementsToGeoJSON([notBuilding, twoPoint]);
        expect(fc.features).toHaveLength(0);
    });

    it('caps the feature count and flags truncation', () => {
        const many = Array.from({ length: 5 }, (_, i) => wayEl(i));
        const fc = overpassElementsToGeoJSON(many, 3);
        expect(fc.features).toHaveLength(3);
        expect(fc.truncated).toBe(true);
    });

    it('passes through a mapped height, else null', () => {
        const withHeight = overpassElementsToGeoJSON([wayEl(1, { building: 'yes', height: '12.5' })]);
        expect(withHeight.features[0].properties.height_m).toBeCloseTo(12.5, 6);
        const plain = overpassElementsToGeoJSON([wayEl(2)]);
        expect(plain.features[0].properties.height_m).toBeNull();
    });
});

describe('osmHeightMeters', () => {
    it('prefers an explicit height tag in metres', () => {
        expect(osmHeightMeters({ height: '9' })).toBe(9);
    });
    it('falls back to building:levels at ~3 m per storey', () => {
        expect(osmHeightMeters({ 'building:levels': '4' })).toBe(12);
    });
    it('is null when nothing usable is tagged', () => {
        expect(osmHeightMeters({ building: 'yes' })).toBeNull();
        expect(osmHeightMeters(null)).toBeNull();
    });
});

describe('buildOverpassQuery', () => {
    it('orders the bbox as Overpass wants (south,west,north,east)', () => {
        // Input bbox is [minLon, minLat, maxLon, maxLat] = [W, S, E, N].
        const q = buildOverpassQuery([15.90, 45.80, 15.91, 45.81]);
        expect(q).toContain('(45.8,15.9,45.81,15.91)');
        expect(q).toContain('way["building"]');
        expect(q).toContain('relation["building"]');
    });
});
