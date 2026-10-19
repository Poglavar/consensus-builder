// floorPlanToGeoJSON (frontend/js/building-floor-plans.js): one floor of a floor model as WGS84 GeoJSON
// for 2D maps. Pins the feature kinds and counts, closed polygon rings (holes included), the bilinear
// unit-square registration (corners and centre), the empty and invalid cases, and that a generated
// ground floor carries the building entrance while a typical floor does not.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';

const require = createRequire(import.meta.url);
const floorPlans = require('../../frontend/js/building-floor-plans.js');
const generator = require('../../frontend/js/default-floor-plans.js');

const M_PER_DEG = Math.PI * 6378137 / 180, LAT = 45.8, LNG = 16.0, MX = M_PER_DEG * Math.cos(LAT * Math.PI / 180);
const lngLat = ([x, y]) => [LNG + x / MX, LAT + y / M_PER_DEG];
// A 10 m square, counter-clockwise from the south-west corner: UV (0,0), (1,0), (1,1), (0,1).
const corners = [[0, 0], [10, 0], [10, 10], [0, 10]].map(lngLat);
const centre = [corners.reduce((sum, c) => sum + c[0], 0) / 4, corners.reduce((sum, c) => sum + c[1], 0) / 4];

const wall = [[[0, 0], [1, 0], [1, 0.03], [0, 0.03]]];
const slabWithHole = [[[0, 0], [1, 0], [1, 1], [0, 1]], [[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6]]];
const plans = {
    schema: floorPlans.SCHEMA,
    registration: { corners, basis: 'A 10 m test square', accuracy: 'test' },
    layouts: [{
        id: 'test-layout',
        source: { url: 'https://example.org/plan.pdf', sha256: 'test-sha256' },
        architecture: {
            schema: floorPlans.ARCHITECTURE_SCHEMA,
            dimensionsM: [10, 10],
            wallHeightM: 2.8,
            slabThicknessM: 0.2,
            walls: [wall],
            slabs: [slabWithHole],
            landings: [],
            openings: [{ kind: 'window', a: [0.2, 0.015], b: [0.4, 0.015], depthM: 0.3, sillM: 0.9, heightM: 1.4 }],
            stairs: [{ a: [0.5, 0.5], b: [0.5, 0.8], widthM: 1.1, steps: 10, fromM: 0, toM: 1.5 }],
            railings: []
        }
    }],
    floors: [{ id: 'ground', level: 0, elevationM: 0, elevationBasis: 'documented', layoutId: 'test-layout' }]
};

const close = (actual, expected) => {
    expect(actual[0]).toBeCloseTo(expected[0], 10);
    expect(actual[1]).toBeCloseTo(expected[1], 10);
};

describe('floorPlanToGeoJSON', () => {
    it('is a valid model to start with', () => {
        expect(floorPlans.validateFloorPlans(plans)).toEqual([]);
    });

    it('emits one feature per wall, slab, opening and stair, tagged with its kind', () => {
        const collection = floorPlans.floorPlanToGeoJSON(plans, 0);
        expect(collection.type).toBe('FeatureCollection');
        const kinds = collection.features.map(feature => feature.properties.kind);
        expect(kinds.slice().sort()).toEqual(['opening', 'slab', 'stair', 'wall']);
        const byKind = Object.fromEntries(collection.features.map(feature => [feature.properties.kind, feature]));
        expect(byKind.slab.geometry.type).toBe('Polygon');
        expect(byKind.wall.geometry.type).toBe('Polygon');
        expect(byKind.opening.geometry.type).toBe('LineString');
        expect(byKind.opening.properties).toMatchObject({ opening: 'window', level: 0, suggested: false });
        expect(byKind.stair.geometry.type).toBe('LineString');
        expect(byKind.stair.properties).toMatchObject({ steps: 10, level: 0 });
    });

    it('closes every polygon ring, the slab\'s hole included', () => {
        const collection = floorPlans.floorPlanToGeoJSON(plans, 0);
        const slab = collection.features.find(feature => feature.properties.kind === 'slab');
        const wallFeature = collection.features.find(feature => feature.properties.kind === 'wall');
        expect(slab.geometry.coordinates).toHaveLength(2);
        expect(slab.geometry.coordinates.map(ring => ring.length)).toEqual([5, 5]);
        expect(wallFeature.geometry.coordinates.map(ring => ring.length)).toEqual([5]);
        for (const ring of [...slab.geometry.coordinates, ...wallFeature.geometry.coordinates]) {
            expect(ring[ring.length - 1]).toEqual(ring[0]);
        }
        // The hole sits inside the outer ring, so the slab really is a floor with a stairwell.
        expect(turf.booleanPointInPolygon(slab.geometry.coordinates[1][0], turf.polygon([slab.geometry.coordinates[0]]))).toBe(true);
        expect(turf.area(slab)).toBeCloseTo(100 - 4, 0);
    });

    it('maps the unit square onto the registration: corners to corners, UV (0.5, 0.5) to the centre', () => {
        const collection = floorPlans.floorPlanToGeoJSON(plans, 0);
        const outer = collection.features.find(feature => feature.properties.kind === 'slab').geometry.coordinates[0];
        corners.forEach((corner, index) => close(outer[index], corner));
        const stair = collection.features.find(feature => feature.properties.kind === 'stair');
        close(stair.geometry.coordinates[0], centre);
        close(floorPlans.registrationToLngLat(plans)(0.5, 0.5), centre);
        // u runs along the first edge (east here), v along the last (north): a swap would put this west of centre.
        const window = collection.features.find(feature => feature.properties.kind === 'opening');
        close(window.geometry.coordinates[0], lngLat([2, 0.15]));
        close(window.geometry.coordinates[1], lngLat([4, 0.15]));
    });

    it('returns an empty collection for a level the model does not have, and refuses an invalid model', () => {
        expect(floorPlans.floorPlanToGeoJSON(plans, 3)).toEqual({ type: 'FeatureCollection', features: [] });
        expect(() => floorPlans.floorPlanToGeoJSON({ ...plans, registration: { ...plans.registration, corners: corners.slice(0, 3) } }, 0))
            .toThrow(/Invalid floorPlans/);
    });

    it('draws each level of a generated model from that floor\'s own layout, marked suggested', () => {
        const footprint = turf.polygon([[[-12, -6], [12, -6], [12, 6], [-12, 6], [-12, -6]].map(lngLat)]);
        const { floorPlans: generated } = generator.planDefaultFloorPlans({ footprint, floors: 3, storeyHeightM: 3, neighbours: [], front: null }, { turf });
        expect(generated).not.toBeNull();
        const layoutOf = level => generated.layouts.find(layout => layout.id === generated.floors.find(floor => floor.level === level).layoutId);
        expect(layoutOf(0).id).not.toBe(layoutOf(1).id); // the ground floor has a layout of its own
        for (const level of [0, 1]) {
            const collection = floorPlans.floorPlanToGeoJSON(generated, level);
            const count = kind => collection.features.filter(feature => feature.properties.kind === kind).length;
            const architecture = layoutOf(level).architecture;
            expect(count('wall'), `walls on ${level}`).toBe(architecture.walls.length);
            expect(count('slab'), `slabs on ${level}`).toBe(architecture.slabs.length);
            expect(count('opening'), `openings on ${level}`).toBe(architecture.openings.length);
            expect(count('stair'), `stairs on ${level}`).toBe(architecture.stairs.length);
            expect(collection.features.every(feature => feature.properties.suggested === true && feature.properties.level === level)).toBe(true);
        }
        // The building is entered through a glazed door on the ground floor.
        expect(floorPlans.floorPlanToGeoJSON(generated, 0).features.some(feature => feature.properties.opening === 'glazedDoor')).toBe(true);
    });
});
