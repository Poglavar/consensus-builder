// Headless geometry contracts for whole-parcel fit and editable lake envelopes.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { appTurf } from '../agents/mcp-geometry.js';

const require = createRequire(import.meta.url);
const { fit } = require('../../frontend/js/structure-parcel-fit.js');
const LakeGeometry = require('../../frontend/js/lake-geometry.js');
const { isSimpleRing } = require('../../frontend/js/single-building-geometry.js');

const feature = (coordinates, parcelId) => ({
    type: 'Feature',
    properties: { parcelId },
    geometry: { type: 'Polygon', coordinates }
});
const rectangle = (west, south, east, north) => [[
    [west, south], [east, south], [east, north], [west, north], [west, south]
]];
const outline = coordinates => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates } });
const turfFeature = geometry => ({ type: 'Feature', properties: {}, geometry });
const expectFitError = (options, code) => {
    let error;
    try { fit(options); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code });
};

describe('structure parcel fit', () => {
    it('largest selects by full parcel area, even when another parcel overlaps more', () => {
        const boundary = outline(rectangle(0, 0, 0.01, 0.01));
        const largeWithSmallerOverlap = feature(rectangle(-0.02, 0, 0.001, 0.01), 'large');
        const smallerWithFullOverlap = feature(rectangle(0.002, 0, 0.008, 0.01), 'small');
        const before = structuredClone([boundary, largeWithSmallerOverlap, smallerWithFullOverlap]);

        const result = fit({ boundary, parcels: [smallerWithFullOverlap, largeWithSmallerOverlap], mode: 'largest', turf: appTurf });

        expect(result.parcelIds).toEqual(['large']);
        expect(result.geometry).toEqual(largeWithSmallerOverlap.geometry);
        expect(appTurf.area(turfFeature(result.geometry))).toBeCloseTo(appTurf.area(largeWithSmallerOverlap), 5);
        expect([boundary, largeWithSmallerOverlap, smallerWithFullOverlap]).toEqual(before);
    });

    it('all unions full touched parcels while retaining holes and disconnected components', () => {
        const donut = {
            type: 'Polygon',
            coordinates: [
                [[0, 0], [0.02, 0], [0.02, 0.02], [0, 0.02], [0, 0]],
                [[0.005, 0.005], [0.005, 0.015], [0.015, 0.015], [0.015, 0.005], [0.005, 0.005]]
            ]
        };
        const parcelWithHole = { type: 'Feature', properties: { parcelId: 'hole' }, geometry: donut };
        const separate = feature(rectangle(0.04, 0, 0.06, 0.02), 'separate');
        const boundary = {
            type: 'Feature', properties: {},
            geometry: { type: 'MultiPolygon', coordinates: [
                rectangle(0.001, 0.001, 0.004, 0.004),
                rectangle(0.042, 0.005, 0.045, 0.015)
            ] }
        };

        const result = fit({ boundary, parcels: [parcelWithHole, separate], mode: 'all', turf: appTurf });

        expect(result.parcelIds).toEqual(['separate', 'hole']);
        expect(result.geometry.type).toBe('MultiPolygon');
        expect(result.geometry.coordinates).toHaveLength(2);
        expect(result.geometry.coordinates.find(polygon => polygon.length === 2)).toBeDefined();
        const resultArea = appTurf.area(turfFeature(result.geometry));
        expect(resultArea).toBeCloseTo(appTurf.area(parcelWithHole) + appTurf.area(separate), 2);
    });

    it('uses deterministic ties and removes exact duplicate parcel geometry', () => {
        const boundary = outline(rectangle(0, 0, 0.02, 0.01));
        const parcelA = feature(rectangle(0, 0, 0.01, 0.01), 'parcel-a');
        const duplicateA = structuredClone(parcelA);
        const parcelB = feature(rectangle(0.01, 0, 0.02, 0.01), 'parcel-b');

        const first = fit({ boundary, parcels: [parcelB, parcelA], mode: 'largest', turf: appTurf });
        const reversed = fit({ boundary, parcels: [parcelA, parcelB], mode: 'largest', turf: appTurf });
        const all = fit({ boundary, parcels: [parcelB, duplicateA, parcelA], mode: 'all', turf: appTurf });

        expect(first.parcelIds).toEqual(['parcel-a']);
        expect(reversed).toEqual(first);
        expect(all.parcelIds).toEqual(['parcel-a', 'parcel-b']);
        expect(all.geometry.type).toBe('Polygon');
    });

    it('excludes edge-only intersections, reports no hits and leaves source data unchanged', () => {
        const boundary = outline(rectangle(0, 0, 0.01, 0.01));
        const edgeOnly = feature(rectangle(0.01, 0, 0.02, 0.01), 'edge');
        const before = structuredClone([boundary, edgeOnly]);

        expectFitError({ boundary, parcels: [edgeOnly], mode: 'all', turf: appTurf }, 'no-touched-parcels');
        expect([boundary, edgeOnly]).toEqual(before);
    });
});

describe('lake geometry editing', () => {
    const simpleLake = {
        type: 'Polygon',
        coordinates: [[[-0.02, -0.02], [0.02, -0.02], [0.02, 0.02], [-0.02, 0.02], [-0.02, -0.02]]]
    };

    it('allows one simple polygon and rejects disconnected and self-crossing boundaries', () => {
        const disconnected = {
            type: 'MultiPolygon',
            coordinates: [simpleLake.coordinates, [[ [0.03, 0], [0.04, 0], [0.04, 0.01], [0.03, 0.01], [0.03, 0] ]]]
        };
        const selfCrossing = {
            type: 'Polygon',
            coordinates: [[[0, 0], [0.02, 0.02], [0, 0.02], [0.02, 0], [0, 0]]]
        };

        expect(LakeGeometry.isEditable(simpleLake, isSimpleRing)).toBe(true);
        expect(LakeGeometry.isEditable({ type: 'MultiPolygon', coordinates: [simpleLake.coordinates] }, isSimpleRing)).toBe(true);
        expect(LakeGeometry.isEditable(disconnected, isSimpleRing)).toBe(false);
        expect(LakeGeometry.isEditable(selfCrossing, isSimpleRing)).toBe(false);
    });

    it('builds shore and water inside a polygon-with-hole envelope without filling the hole', () => {
        const withHole = {
            type: 'Polygon',
            coordinates: [
                [[0, 0], [0.04, 0], [0.04, 0.04], [0, 0.04], [0, 0]],
                [[0.015, 0.015], [0.015, 0.025], [0.025, 0.025], [0.025, 0.015], [0.015, 0.015]]
            ]
        };
        const built = LakeGeometry.build(withHole, { turf: appTurf, shoreWidthMeters: 80 });
        const hole = [0.02, 0.02];
        const interiorWater = [0.008, 0.008];

        expect(built).not.toBeNull();
        expect(built.geometry).toEqual(withHole);
        expect(appTurf.booleanPointInPolygon(appTurf.point(hole), turfFeature(built.geometry))).toBe(false);
        expect(appTurf.booleanPointInPolygon(appTurf.point(hole), turfFeature(built.shore))).toBe(false);
        expect(built.water).not.toBeNull();
        expect(appTurf.booleanPointInPolygon(appTurf.point(hole), turfFeature(built.water))).toBe(false);
        expect(appTurf.booleanPointInPolygon(appTurf.point(interiorWater), turfFeature(built.water))).toBe(true);
    });
});
