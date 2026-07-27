// Unit tests for photo-mode building protection: which standing buildings are painted into the carve
// mask as "do not cut". The failure that motivated it was a road running up to a wall and shearing
// the facade off, so the tests that matter are (a) a standing building IS protected with a collar and
// (b) a building a proposal removes is NOT — protecting that one would leave a demolished building
// standing in the render.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const {
    selectProtectedBuildingFootprints,
    isStandingSurveyBuilding,
    BUILDING_PROTECT_DILATE_M,
    MASK_ORDER
} = require('../../frontend/js/photoreal-protect.js');

// Zagreb-ish, so metres-per-degree is realistic for the buffer assertions.
const LNG0 = 15.97;
const LAT0 = 45.80;
const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos(LAT0 * Math.PI / 180);

// Axis-aligned square of `size` metres centred `east`/`north` metres from the origin point.
function squareM(east, north, size) {
    const half = size / 2;
    const cx = LNG0 + east / M_PER_DEG_LNG;
    const cy = LAT0 + north / M_PER_DEG_LAT;
    const dx = half / M_PER_DEG_LNG;
    const dy = half / M_PER_DEG_LAT;
    return {
        type: 'Polygon',
        coordinates: [[
            [cx - dx, cy - dy], [cx + dx, cy - dy], [cx + dx, cy + dy], [cx - dx, cy + dy], [cx - dx, cy - dy]
        ]]
    };
}

const building = (geometry, properties) => ({ type: 'Feature', properties: properties || {}, geometry });
const WIDE_BOUNDS = [LNG0 - 0.01, LAT0 - 0.01, LNG0 + 0.01, LAT0 + 0.01];
const select = (features, options) => selectProtectedBuildingFootprints(
    features, Object.assign({ turf, bounds: WIDE_BOUNDS }, options || {}));
const totalArea = geometries => geometries.reduce(
    (sum, g) => sum + turf.area({ type: 'Feature', properties: {}, geometry: g }), 0);

describe('MASK_ORDER', () => {
    // The mask RT has no depth buffer and every class writes with NoBlending, so draw order alone
    // decides who owns a texel. Protection has to be strictly last: a tie with the road quilt (both
    // were 3 briefly) leaves it to three's material sort whether a facade survives.
    it('draws protection strictly after every cut class', () => {
        const cuts = [MASK_ORDER.keepVeg, MASK_ORDER.full, MASK_ORDER.roadEntry, MASK_ORDER.roadPatch];
        cuts.forEach(order => expect(MASK_ORDER.protect).toBeGreaterThan(order));
    });

    it('gives every class its own rung', () => {
        const orders = Object.values(MASK_ORDER);
        expect(new Set(orders).size).toBe(orders.length);
    });

    it('keeps full cuts above keep-veg, so a road through a park still clears', () => {
        expect(MASK_ORDER.full).toBeGreaterThan(MASK_ORDER.keepVeg);
    });
});

describe('isStandingSurveyBuilding', () => {
    it('accepts a survey footprint', () => {
        expect(isStandingSurveyBuilding(building(squareM(0, 0, 20), { object_id: 'gdi-1' }))).toBe(true);
    });

    it('rejects a proposal building — the mesh under it must be cut away', () => {
        expect(isStandingSurveyBuilding(building(squareM(0, 0, 20), { proposalId: '95' }))).toBe(false);
    });

    it('rejects a feature with no polygonal geometry', () => {
        expect(isStandingSurveyBuilding(building({ type: 'Point', coordinates: [LNG0, LAT0] }))).toBe(false);
        expect(isStandingSurveyBuilding(building(null))).toBe(false);
        expect(isStandingSurveyBuilding(null)).toBe(false);
    });
});

describe('selectProtectedBuildingFootprints', () => {
    it('returns nothing for empty input', () => {
        expect(select([])).toEqual([]);
        expect(select(null)).toEqual([]);
    });

    it('protects a standing building and grows it by the facade collar', () => {
        const footprint = squareM(0, 0, 20);
        const out = select([building(footprint, { object_id: 'gdi-1' })]);
        expect(out).toHaveLength(1);
        const grown = turf.area({ type: 'Feature', properties: {}, geometry: out[0] });
        // 20x20 = 400 m²; a 1 m collar takes it to roughly 22x22 = 484 m² (rounded corners).
        expect(grown).toBeGreaterThan(400);
        expect(grown).toBeLessThan(520);
        expect(BUILDING_PROTECT_DILATE_M).toBeGreaterThan(0);
    });

    it('protects the wall itself: a point 0.5 m outside the outline is inside the protected area', () => {
        const out = select([building(squareM(0, 0, 20), { object_id: 'gdi-1' })]);
        const justOutside = turf.point([LNG0 + 10.5 / M_PER_DEG_LNG, LAT0]);
        expect(turf.booleanPointInPolygon(justOutside, out[0])).toBe(true);
    });

    it('never protects a proposal building', () => {
        const out = select([building(squareM(0, 0, 20), { proposalId: '95', buildingIndex: 0 })]);
        expect(out).toEqual([]);
    });

    it('skips buildings outside the carve window', () => {
        const near = building(squareM(0, 0, 20), { object_id: 'near' });
        const far = building(squareM(5000, 0, 20), { object_id: 'far' });
        const out = select([near, far], { bounds: [LNG0 - 0.001, LAT0 - 0.001, LNG0 + 0.001, LAT0 + 0.001] });
        expect(out).toHaveLength(1);
    });

    it('drops a building a proposal razes entirely', () => {
        const footprint = squareM(0, 0, 20);
        const out = select([building(footprint, { object_id: 'razed' })], { removals: [footprint] });
        expect(out).toEqual([]);
    });

    it('keeps a razed footprint cut even when a surviving twin overlaps it', () => {
        // Two surveys outline the same building slightly differently. One is razed; the other must
        // not smuggle the demolished volume back into the render.
        const razed = squareM(0, 0, 20);
        const twin = squareM(1, 1, 20);
        const out = select([building(twin, { object_id: 'osm-twin' })], { removals: [razed] });
        const centre = turf.point([LNG0, LAT0]);
        out.forEach(geometry => expect(turf.booleanPointInPolygon(centre, geometry)).toBe(false));
    });

    it('protects only the part of a building outside a neighbouring removal', () => {
        const footprint = squareM(0, 0, 20);          // spans -10..+10 east
        const removal = squareM(-15, 0, 20);          // spans -25..-5 east
        const out = select([building(footprint, { object_id: 'clipped' })], { removals: [removal] });
        expect(out.length).toBeGreaterThan(0);
        const kept = totalArea(out);
        expect(kept).toBeGreaterThan(50);
        expect(kept).toBeLessThan(400);
        // Deep inside the removal stays cut; the far side of the building stays protected.
        expect(out.some(g => turf.booleanPointInPolygon(
            turf.point([LNG0 - 8 / M_PER_DEG_LNG, LAT0]), g))).toBe(false);
        expect(out.some(g => turf.booleanPointInPolygon(
            turf.point([LNG0 + 8 / M_PER_DEG_LNG, LAT0]), g))).toBe(true);
    });

    it('honours the removal buffer, so a cut is not re-protected by an adjacent collar', () => {
        const footprint = squareM(0, 0, 20);
        const removal = squareM(-15, 0, 20);
        const tight = select([building(footprint, { object_id: 'a' })],
            { removals: [removal], removalBufferM: 0 });
        const buffered = select([building(footprint, { object_id: 'a' })],
            { removals: [removal], removalBufferM: 1.2 });
        expect(totalArea(buffered)).toBeLessThan(totalArea(tight));
    });

    it('ignores features with no usable geometry instead of throwing', () => {
        const out = select([
            building(null, { object_id: 'broken' }),
            building({ type: 'LineString', coordinates: [[LNG0, LAT0], [LNG0 + 0.001, LAT0]] }),
            building(squareM(0, 0, 20), { object_id: 'good' })
        ]);
        expect(out).toHaveLength(1);
    });

    it('accepts MultiPolygon footprints', () => {
        const multi = {
            type: 'MultiPolygon',
            coordinates: [squareM(0, 0, 20).coordinates[0], squareM(60, 0, 20).coordinates[0]]
                .map(ring => [ring])
        };
        const out = select([building(multi, { object_id: 'multi' })]);
        expect(out).toHaveLength(1);
        expect(totalArea(out)).toBeGreaterThan(800);
    });

    it('does nothing without turf rather than throwing', () => {
        expect(selectProtectedBuildingFootprints(
            [building(squareM(0, 0, 20), {})], { turf: null, bounds: WIDE_BOUNDS })).toEqual([]);
    });
});
